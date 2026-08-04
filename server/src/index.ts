import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { registerRoutes } from "./livedocRoutes.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

registerRoutes(app);

createServer(app).listen(PORT, () => {
  console.log(`LiveDoc API proxy listening on http://localhost:${PORT}`);
});
