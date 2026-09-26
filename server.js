require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { BlobServiceClient } = require("@azure/storage-blob");

const app = express();
const PORT = process.env.PORT || 5001;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// Environment Variables
// --------------------------------------------------

const connectionString =
  process.env.AZURE_STORAGE_CONNECTION_STRING;

const containerName =
  process.env.AZURE_STORAGE_CONTAINER || "audit-records";

if (!connectionString) {
  console.error(
    "ERROR: AZURE_STORAGE_CONNECTION_STRING is missing in .env"
  );

  process.exit(1);
}

// --------------------------------------------------
// Azure Blob Service Connection
// --------------------------------------------------

let blobServiceClient;

try {
  blobServiceClient =
    BlobServiceClient.fromConnectionString(
      connectionString
    );
} catch (error) {
  console.error(
    "ERROR: Invalid Azure Storage connection string."
  );

  console.error(error.message);

  process.exit(1);
}

// --------------------------------------------------
// ROOT ROUTE
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Azure Storage Lifecycle API",
    health: "/api/health",
    blobs: "/api/blobs",
  });
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Azure Storage Lifecycle API is running",
  });
});

// --------------------------------------------------
// DASHBOARD DATA
// --------------------------------------------------

app.get("/api/dashboard", (req, res) => {
  res.json({
    totalRecords: 1250,
    totalStorage: "4.8 TB",
    hotRecords: 320,
    coolRecords: 410,
    archiveRecords: 520,
    estimatedSavings: "62%",
  });
});

// --------------------------------------------------
// GET ALL BLOBS
// --------------------------------------------------

app.get("/api/blobs", async (req, res) => {
  try {
    const containerClient =
      blobServiceClient.getContainerClient(
        containerName
      );

    const blobs = [];

    for await (
      const blob of containerClient.listBlobsFlat()
    ) {
      blobs.push({
        name: blob.name,

        size:
          blob.properties.contentLength || 0,

        tier:
          blob.properties.accessTier ||
          "Unknown",

        lastModified:
          blob.properties.lastModified ||
          null,

        blobType:
          blob.properties.blobType ||
          "Unknown",

        archiveStatus:
          blob.properties.archiveStatus ||
          null,
      });
    }

    res.json({
      success: true,
      container: containerName,
      count: blobs.length,
      blobs,
    });
  } catch (error) {
    console.error(
      "Error reading Azure blobs:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to read Azure Blob Storage.",
      error: error.message,
    });
  }
});

// --------------------------------------------------
// GET ONE BLOB
// --------------------------------------------------

app.get("/api/blob/:name", async (req, res) => {
  try {
    const blobName =
      decodeURIComponent(req.params.name);

    const containerClient =
      blobServiceClient.getContainerClient(
        containerName
      );

    const blobClient =
      containerClient.getBlobClient(
        blobName
      );

    const properties =
      await blobClient.getProperties();

    res.json({
      success: true,

      blob: {
        name: blobName,

        size:
          properties.contentLength || 0,

        tier:
          properties.accessTier ||
          "Unknown",

        blobType:
          properties.blobType ||
          "Unknown",

        lastModified:
          properties.lastModified ||
          null,

        archiveStatus:
          properties.archiveStatus ||
          null,

        rehydratePriority:
          properties.rehydratePriority ||
          null,
      },
    });
  } catch (error) {
    console.error(
      "Blob details error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to read blob details.",
      error: error.message,
    });
  }
});

// --------------------------------------------------
// LIFECYCLE RECOMMENDATION
// --------------------------------------------------

app.post("/api/lifecycle", async (req, res) => {
  try {
    const {
      recordAge,
      currentTier,
    } = req.body;

    let recommendedTier = "Hot";

    if (recordAge >= 5) {
      recommendedTier = "Archive";
    } else if (recordAge >= 1) {
      recommendedTier = "Cool";
    }

    res.json({
      success: true,
      recordAge,
      currentTier,
      recommendedTier,

      message:
        `${recordAge}-year-old record is recommended for ${recommendedTier} tier`,
    });
  } catch (error) {
    console.error(
      "Lifecycle error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Lifecycle recommendation failed.",
      error: error.message,
    });
  }
});

// --------------------------------------------------
// CHANGE BLOB TIER
// Hot / Cool / Archive
// --------------------------------------------------

app.post("/api/change-tier", async (req, res) => {
  try {
    const {
      recordName,
      tier,
    } = req.body;

    if (!recordName) {
      return res.status(400).json({
        success: false,
        message:
          "recordName is required",
      });
    }

    if (
      !["Hot", "Cool", "Archive"].includes(
        tier
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "tier must be Hot, Cool, or Archive",
      });
    }

    const containerClient =
      blobServiceClient.getContainerClient(
        containerName
      );

    const blobClient =
      containerClient.getBlobClient(
        recordName
      );

    await blobClient.setAccessTier(
      tier
    );

    res.json({
      success: true,
      recordName,
      tier,

      message:
        `${recordName} tier change requested to ${tier}`,
    });
  } catch (error) {
    console.error(
      "Tier change error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to change blob tier.",
      error: error.message,
    });
  }
});

// --------------------------------------------------
// REAL ARCHIVE REHYDRATION
// Archive -> Hot
// --------------------------------------------------

app.post("/api/rehydrate", async (req, res) => {
  try {
    const {
      recordName,
      priority,
    } = req.body;

    if (!recordName) {
      return res.status(400).json({
        success: false,
        message:
          "recordName is required",
      });
    }

    const containerClient =
      blobServiceClient.getContainerClient(
        containerName
      );

    const blobClient =
      containerClient.getBlobClient(
        recordName
      );

    const properties =
      await blobClient.getProperties();

    const currentTier =
      properties.accessTier ||
      "Unknown";

    console.log(
      `Current tier for ${recordName}: ${currentTier}`
    );

    const azurePriority =
      priority === "High Priority" ||
      priority === "High"
        ? "High"
        : "Standard";

    await blobClient.setAccessTier(
      "Hot",
      {
        rehydratePriority:
          azurePriority,
      }
    );

    res.json({
      success: true,

      recordName,

      previousTier:
        currentTier,

      targetTier:
        "Hot",

      priority:
        azurePriority,

      message:
        `${azurePriority} rehydration started for ${recordName}`,
    });
  } catch (error) {
    console.error(
      "Rehydration error:",
      error
    );

    res.status(500).json({
      success: false,

      message:
        "Rehydration request failed",

      error:
        error.message,
    });
  }
});

// --------------------------------------------------
// SERVER START
// --------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(
    "--------------------------------------"
  );

  console.log(
    "Azure Storage Lifecycle API"
  );

  console.log(
    `Server: http://localhost:${PORT}`
  );

  console.log(
    `Container: ${containerName}`
  );

  console.log(
    "--------------------------------------"
  );
});

// --------------------------------------------------
// SERVER ERROR HANDLING
// --------------------------------------------------

server.on("error", (error) => {
  console.error(
    "SERVER ERROR:"
  );

  console.error(
    error
  );
});

server.on("close", () => {
  console.log(
    "SERVER CLOSED"
  );
});

// --------------------------------------------------
// GLOBAL ERROR HANDLING
// --------------------------------------------------

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:"
    );

    console.error(
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "UNHANDLED REJECTION:"
    );

    console.error(
      error
    );
  }
);