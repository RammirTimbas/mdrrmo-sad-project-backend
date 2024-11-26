const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const app = express();
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const fs = require("fs");
const crypto = require("crypto");
const emailjs = require("emailjs-com");
const path = require("path");
const {
  getStorage,
  ref,
  listAll,
  getDownloadURL,
} = require("firebase-admin/storage");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();
app.use(bodyParser.json());
const wss = new WebSocket.Server({ server });
app.use(express.json());

const PORT = process.env.PORT;
const server = http.createServer(app);


server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});


const allowedOrigins = [
  "https://mdrrmo---tpms.web.app",
  "https://mdrrmo---tpms.firebaseapp.com",
];

//caching
let trainingProgramsCache = null;
let ratedtrainingProgramsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000;

app.options("/api/*", cors());

app.use(
  cors({
    origin: function (origin, callback) {
      console.log('Request headers:', req.headers); // Log request headers for more insight
      console.log('Incoming Origin:', origin); // Log origin

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true); // Allow request
      } else {
        callback(new Error('Not allowed by CORS')); // Block request
      }
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);



wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (!allowedOrigins.includes(origin)) {
    ws.close();
    console.log("WebSocket connection rejected due to origin mismatch");
    return;
  }
  console.log("WebSocket connection established");
});
// websocket server

//const serviceAccount = require("./firebase-adminsdk.json");

const firebasePrivateKeyB64 = Buffer.from(
  process.env.FIREBASE_PRIVATE_KEY_BASE64,
  "base64"
);
const firebasePrivateKey = firebasePrivateKeyB64.toString("utf8");

const firebaseCredentials = {
  type: process.env.FIREBASE_TYPE,
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  privateKey: firebasePrivateKey,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  clientId: process.env.FIREBASE_CLIENT_ID,
  authUri: process.env.FIREBASE_AUTH_URI,
  tokenUri: process.env.FIREBASE_TOKEN_URI,
  authProviderX509CertUrl: process.env.FIREBASE_AUTH_PROVIDER,
  clientX509CertUrl: process.env.FIREBASE_CLIENT_URL,
  universeDomain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(firebaseCredentials),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket();

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ENGAGEMENT LAYOUT

//get engagement data
const CACHE_DURATION_ENGAGEMENT = 3600000; // 1 hour

// Engagement data endpoint
app.get("/api/engagements", async (req, res) => {
  try {
    const currentTime = Date.now();

    // check if cached data is available and valid
    if (
      ratedtrainingProgramsCache &&
      cacheTimestamp &&
      currentTime - cacheTimestamp < CACHE_DURATION_ENGAGEMENT
    ) {
      console.log("Serving from cache");
      return res.json(ratedtrainingProgramsCache);
    }

    console.log("Fetching data from Firestore");
    const programsSnapshot = await db.collection("Training Programs").get();
    const ratedProgramsData = [];

    for (const programDoc of programsSnapshot.docs) {
      const programId = programDoc.id;
      const programData = programDoc.data();
      const ratingsSnapshot = await db
        .collection("Training Programs")
        .doc(programId)
        .collection("ratings")
        .get();

      let totalProgramRating = 0;
      let totalTrainerRating = 0;
      let ratingCount = 0;

      ratingsSnapshot.forEach((ratingDoc) => {
        const ratingData = ratingDoc.data();
        if (ratingData.programRating && ratingData.trainerRating) {
          totalProgramRating += ratingData.programRating;
          totalTrainerRating += ratingData.trainerRating;
          ratingCount++;
        }
      });

      if (ratingCount > 0) {
        const averageProgramRating = totalProgramRating / ratingCount;
        const averageTrainerRating = totalTrainerRating / ratingCount;
        const overallAverage =
          (averageProgramRating + averageTrainerRating) / 2;

        ratedProgramsData.push({
          id: programId,
          program_title: programData.program_title || "No Title",
          trainer_assigned: programData.trainer_assigned || "No Trainer",
          type: programData.type || "Undefined",
          ratingCount,
          averageRating: parseFloat(overallAverage.toFixed(2)),
          thumbnail: programData.thumbnail || "https://via.placeholder.com/100",
        });
      }
    }

    // Update cache with new data
    ratedtrainingProgramsCache = ratedProgramsData;
    cacheTimestamp = currentTime;

    res.json(ratedProgramsData);
  } catch (error) {
    console.error("Error fetching ratings:", error);
    res.status(500).json({ error: "Failed to fetch ratings" });
  }
});

// SETTINGS LAYOUT

//verify admin password
app.post("/verify-admin-password", async (req, res) => {
  const { userId, password } = req.body;

  try {
    const adminDocRef = db.collection("Users").doc(userId);
    const adminDoc = await adminDocRef.get();

    if (adminDoc.exists) {
      const storedHashedPassword = adminDoc.data().password;

      const passwordMatch = bcrypt.compareSync(password, storedHashedPassword);

      if (passwordMatch) {
        return res.status(200).json({ verified: true });
      }
    }

    return res.status(401).json({ verified: false });
  } catch (error) {
    console.error("Error verifying password:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

//add new admin
app.post("/add-admin", async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const hashedPassword = bcrypt.hashSync(password, 10);

    await db.collection("Users").add({
      name,
      email,
      password: hashedPassword,
      profile: "admin",
    });

    res.status(201).json({ message: "Admin added successfully" });
  } catch (error) {
    console.error("Error adding admin:", error);
    res.status(500).json({ message: "Failed to add admin" });
  }
});

//get logs
app.get("/logs", async (req, res) => {
  try {
    const logsSnapshot = await db.collection("Logs").get(); // Using Admin SDK method
    const logs = logsSnapshot.docs.map((doc) => {
      const logData = doc.data();

      if (logData.date && logData.date.toDate) {
        logData.date = logData.date.toDate(); // Convert Firestore Timestamp to JS Date
      }
      return logData;
    });
    res.status(200).json(logs); // Sending logs as a response
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch logs" });
  }
});

//USERS LAYOUT

// get all users
app.get("/users", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("User Informations").get(); // Use Admin SDK method
    const usersData = usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(usersData);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// TRAINING PROGRAMS (ADMIN)

app.get("/programs", async (req, res) => {
  try {
    const querySnapshot = await db.collection("Training Programs").get();
    const programsData = querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json(programsData); // Send the programs data as a response
  } catch (error) {
    console.error("Error fetching programs:", error);
    res.status(500).json({ message: "Error fetching programs" });
  }
});

//TRAINING PROGRAMS VIEW

app.get("/training-programs", async (req, res) => {
  try {
    const now = Date.now(); // Current time in milliseconds
    const nowSeconds = Math.floor(now / 1000); // Convert to Unix timestamp

    // Serve from cache if valid
    if (
      trainingProgramsCache &&
      cacheTimestamp &&
      now - cacheTimestamp < CACHE_DURATION
    ) {
      console.log("Serving training programs from cache");
      return res.status(200).json(trainingProgramsCache);
    }

    // Fetch only relevant documents from Firestore
    const programsSnapshot = await db
      .collection("Training Programs")
      .where("end_date", ">=", nowSeconds) // Filter by end_date >= now
      .where("start_date", ">", nowSeconds) // Filter by start_date > now
      .get();

    const programsData = programsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Update the cache
    trainingProgramsCache = programsData;
    cacheTimestamp = Date.now();

    console.log("Serving fresh training programs data and updating cache");
    res.status(200).json(programsData);
  } catch (error) {
    console.error("Error fetching training programs:", error);
    res.status(500).json({ message: "Failed to fetch training programs" });
  }
});

// USERPANEL

//get user info
app.get("/api/user-info/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const userCollection = db.collection("User Informations");
    const querySnapshot = await userCollection
      .where("user_ID", "==", userId)
      .get();

    if (!querySnapshot.empty) {
      const userDoc = querySnapshot.docs[0].data();
      res.status(200).json(userDoc);
    } else {
      res
        .status(404)
        .json({ message: `No user information found for userId: ${userId}` });
    }
  } catch (error) {
    console.error("Error fetching user information:", error);
    res.status(500).json({ error: "Error fetching user information" });
  }
});

//Carousel

app.get("/api/get-carousel-images", async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: "carousel-images/" }); // List files in the 'carousel-images' folder
    const imageUrls = await Promise.all(
      files.map(async (file) => {
        const url = await file.getSignedUrl({
          action: "read",
          expires: "03-09-2491",
        }); // Generate signed URL for each file
        return { name: file.name, url: url[0] };
      })
    );
    res.status(200).json(imageUrls); // Send the image URLs to the frontend
  } catch (error) {
    console.error("Error fetching images:", error);
    res.status(500).json({ error: "Failed to fetch images" });
  }
});

//PASSWORD VERIFY

// Backend: Verify admin password
app.post("/verify-admin-password", async (req, res) => {
  const { password } = req.body;

  try {
    const adminUserId = "X3kBIoe4ugtvz04azO6Q";
    const adminDocRef = db.collection("Users").doc(adminUserId);
    const adminDoc = await adminDocRef.get();

    if (adminDoc.exists) {
      const storedHashedPassword = adminDoc.data().password;

      const passwordMatch = bcrypt.compareSync(password, storedHashedPassword);

      if (passwordMatch) {
        return res.status(200).json({ verified: true });
      }
    }

    return res.status(401).json({ verified: false });
  } catch (error) {
    console.error("Error verifying password:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

//FORGOT PASSWORD

const generateCode = () => {
  return crypto.randomInt(10000000, 99999999).toString(); // 8-digit code
};

// request password reset
app.post("/request-password-reset", async (req, res) => {
  const { email } = req.body;

  //check if the email exists in Firestore
  const userRef = db.collection("Users").where("email", "==", email);
  const snapshot = await userRef.get();

  if (snapshot.empty) {
    return res.status(404).json({ message: "Email not found" });
  }

  // generate a recovery code and expiration time
  const recoveryCode = generateCode();
  const expirationTime = Date.now() + 30 * 60 * 1000; // 30 minutes expiration

  // store the recovery code and expiration in Firestore
  await db.collection("Users").doc(snapshot.docs[0].id).update({
    recoveryCode,
    recoveryCodeExpiration: expirationTime,
  });

  res.status(200).json({ recoveryCode, email });
});

// verify the recovery code
app.post("/verify-recovery-code", async (req, res) => {
  const { email, code } = req.body;

  // check if email exists and retrieve the stored recovery code
  const userRef = db.collection("Users").where("email", "==", email);
  const snapshot = await userRef.get();

  if (snapshot.empty) {
    return res.status(404).json({ message: "Email not found" });
  }

  const user = snapshot.docs[0].data();
  const { recoveryCode, recoveryCodeExpiration } = user;

  // vlidate code and expiration
  if (recoveryCode !== code || recoveryCodeExpiration < Date.now()) {
    return res.status(400).json({ message: "Invalid or expired code" });
  }

  res.status(200).json({ message: "Code verified" });
});

// reset the password
app.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;

  // update password in Firestore
  // check if the email exists in Firestore
  const userRef = db.collection("Users").where("email", "==", email);
  const snapshot = await userRef.get();

  if (snapshot.empty) {
    return res.status(404).json({ message: "Email not found" });
  }

  try {
    // hash the new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10);

    // update password in Firestore
    await db.collection("Users").doc(snapshot.docs[0].id).update({
      password: hashedPassword,
      recoveryCode: null,
      recoveryCodeExpiration: null,
    });

    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ message: "Failed to reset password" });
  }
});