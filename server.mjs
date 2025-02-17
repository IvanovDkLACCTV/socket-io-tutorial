import express from "express"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Server } from "socket.io"
import cors from "cors"
import sqlite3 from "sqlite3"
import { open } from "sqlite"

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
})

const log = console.log

const __dirname = dirname(fileURLToPath(import.meta.url))

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"))
})

io.on("connection", (socket) => {
  console.log("a user connected")

  socket.on("chat message", (msg) => {
    console.log("message: " + msg)
    // Отправляем сообщение всем подключённым клиентам
    io.emit("chat message", msg)
  })

  socket.on("disconnect", () => {
    console.log("user disconnected")
  })
})

io.on("connection", async (socket) => {
  socket.on("chat message", async (msg) => {
    let result
    try {
      result = await db.run("INSERT INTO messages (content) VALUES (?)", msg)
    } catch (e) {
      // TODO handle the failure
      return
    }
    io.emit("chat message", msg, result.lastID)
  })

  if (!socket.recovered) {
    // if the connection state recovery was not successful
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

server.listen(3000, () => {
  log("server running at http://localhost:3000")
})
