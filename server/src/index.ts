import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

// Import the API routes
import chatRouter from "./routes/api/chat";
import debugRouter from "./routes/api/debug";
import debugOutputsRouter from "./routes/api/debug/outputs";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// Mount the routers with paths that mimic your Next.js API endpoints:
app.use("/api/chat", chatRouter);
app.use("/api/debug/outputs", debugOutputsRouter);
// For /api/debug, all other actions (launch, evaluate, etc.) will be handled in this router.
app.use("/api/debug", debugRouter);

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
