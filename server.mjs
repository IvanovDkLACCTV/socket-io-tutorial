import express from "express"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Server } from "socket.io"
import cors from "cors"
import sqlite3 from "sqlite3"
import { open } from "sqlite"
import { availableParallelism } from "node:os"
import cluster from "node:cluster"
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter"

// open the database file
const db = await open({
  filename: "chat.db",
  driver: sqlite3.Database,
})

// create our 'messages' table (you can ignore the 'client_offset' column for now)
await db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT
  );
`)

if (cluster.isPrimary) {
  const numCPUs = availableParallelism()
  // create one worker per available core
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({
      PORT: 3000 + i,
    })
  }

  // set up the adapter on the primary thread
  setupPrimary()
} else {
  const app = express()
  const server = createServer(app)

  // Настройка CORS для Express
  app.use(
    cors({
      origin: "http://127.0.0.1:5500", // Разрешаем запросы только от этого origin
      methods: ["GET", "POST"],
      credentials: true, // Разрешаем передачу куки и заголовков авторизации
    })
  )

  // Настройка CORS для Socket.IO
  const io = new Server(server, {
    cors: {
      origin: "http://127.0.0.1:5500", // Разрешаем запросы только от этого origin
      methods: ["GET", "POST"],
    },
    connectionStateRecovery: {},
    cookie: {},
    // set up the adapter on each worker thread
    adapter: createAdapter(),
  })
  const log = console.log

  const __dirname = dirname(fileURLToPath(import.meta.url))

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"))
  })

  io.on("connection", async (socket) => {
    console.log("a user connected")

    socket.on("chat message", async (msg, clientOffset, callback) => {
      let result
      try {
        result = await db.run(
          "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
          msg,
          clientOffset
        )
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          // the message was already inserted, so we notify the client
          callback()
        } else {
          // nothing to do, just let the client retry
        }
        return
      }
      io.emit("chat message", msg, result.lastID)
      // acknowledge the event
      callback()
    })

    // Logic for recovering messages
    if (!socket.recovered) {
      try {
        await db.each(
          "SELECT id, content FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id)
          }
        )
      } catch (e) {
        // something went wrong
      }
    }
  })

  // each worker will listen on a distinct port
  const port = process.env.PORT

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`)
  })
}
