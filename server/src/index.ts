import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

// Import the API routes
import chatRouter from "./routes/api/chat";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// Mount the routers with paths that mimic your Next.js API endpoints:
app.use("/api/chat", chatRouter);

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
