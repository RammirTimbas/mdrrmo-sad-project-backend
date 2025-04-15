const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const app = express();
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const emailjs = require("emailjs-com");
const path = require("path");
const fs = require("fs");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const { google } = require("googleapis");
const session = require("express-session");
const router = express.Router();
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const server = require("http").createServer(app);
require("dotenv").config();
const ExcelJS = require("exceljs");
const multer = require("multer");
const JSZip = require("jszip");
const { readFile, writeFile } = require("fs/promises");
const { v4: uuidv4 } = require("uuid");

const upload = multer({
  storage: multer.memoryStorage(), // Use memory storage or disk storage
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit: 10MB
});

const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  WidthType,
} = require("docx");

const {
  getStorage,
  ref,
  listAll,
  getDownloadURL,
} = require("firebase-admin/storage");
const { userInfo } = require("os");

const PORT = 5000; // Hardcoded for testing

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(bodyParser.json());

const allowedOrigins = [
  "https://mdrrmo---tpms.web.app",
  "https://mdrrmo---tpms.firebaseapp.com",
  "http://localhost:3000",
  "http://localhost:5000",
];

const SECRET_KEY = process.env.SECRET_KEY || "rammir_key";

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 1 day expiration
    },
  })
);

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin;
  if (!allowedOrigins.includes(origin)) {
    ws.close();
    console.log("WebSocket connection rejected due to origin mismatch");
    return;
  }
  console.log("WebSocket connection established");
});

app.options("/api/*", cors());

app.use(
  cors({
    origin: function (origin, callback) {
      console.log("Incoming Origin:", origin);

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  universe_domain: process.env.UNIVERSE_DOMAIN,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket();

//caching
let trainingProgramsCache = null;
let ratedtrainingProgramsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000;

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

//LOGIN and AUTH

app.post("/login", async (req, res) => {
  const { email, password, isTrainerLogin } = req.body;

  try {
    // check if the user is an applicant or a trainer
    const collectionName = isTrainerLogin ? "Trainer Name" : "Users";
    const usersRef = db.collection(collectionName);
    const snapshot = await usersRef.where("email", "==", email).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const userDoc = snapshot.docs[0];
    const userData = userDoc.data();

    // verify pass
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // generate token
    const token = jwt.sign(
      {
        userId: userDoc.id,
        profile: userData.profile,
        trainerName: isTrainerLogin ? userData.trainer_name : null,
      },
      SECRET_KEY,
      { expiresIn: "1h" }
    );

    await db.collection("Sessions").doc(userDoc.id).set({
      userId: userDoc.id,
      profile: userData.profile,
      lastActive: new Date(),
    });

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "None",
      maxAge: 3600000, // 1 hour
    });

    res.json({
      message: "Login successful",
      userId: userDoc.id,
      profile: userData.profile,
      trainerName: isTrainerLogin ? userData.trainer_name : null,
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

//logout
app.post("/logout", async (req, res) => {
  try {
    const token = req.cookies.auth_token;
    if (!token) {
      return res.json({ message: "Already logged out" });
    }

    // check jwt token
    const decoded = jwt.verify(token, SECRET_KEY);

    await db.collection("Sessions").doc(decoded.userId).delete();

    res.clearCookie("auth_token");
    res.json({ message: "Logout successful" });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

//verify jwt sectet token
const verifyToken = async (req, res, next) => {
  console.log("🔍 Incoming cookies:", req.cookies);

  const token = req.cookies.auth_token;
  if (!token) {
    console.log("🚨 No auth token found in request!");
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.user = decoded;

    console.log("✅ Token verified:", decoded);

    await db.collection("Sessions").doc(decoded.userId).update({
      lastActive: new Date(),
    });

    next();
  } catch (error) {
    console.error("❌ Invalid or expired token:", error);
    res.status(401).json({ error: "Invalid or expired token" });
  }
};
/*
//check session - 30 mins time out
app.get("/check-session", verifyToken, async (req, res) => {
  try {
    console.log("🔍 Checking session for user:", req.user); // for debugginh

    const sessionRef = db.collection("Sessions").doc(req.user.userId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      console.warn("🚨 No session found for user:", req.user.userId);
      return res.status(401).json({ error: "Session expired" });
    }

    const sessionData = sessionSnap.data();
    console.log("✅ Found session:", sessionData);

    if (!sessionData.lastActive) {
      console.warn("⚠️ Missing lastActive field in session data!");
      return res.status(500).json({ error: "Session data corrupted" });
    }

    const lastActive = sessionData.lastActive.toDate().getTime();
    const now = Date.now();

    console.log("⏳ Last Active:", new Date(lastActive));
    console.log("🕒 Current Time:", new Date(now));

    if (now - lastActive > 10 * 60 * 1000) {
      console.log("🚪 Session timeout. Deleting session...");
      await sessionRef.delete();
      res.clearCookie("auth_token");
      return res.status(401).json({ error: "Session timed out" });
    }

    res.json({ userId: req.user.userId, profile: req.user.profile });
  } catch (error) {
    console.error("❌ Internal Server Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}); */

app.get("/check-session", verifyToken, async (req, res) => {
  try {
    console.log("🔍 Checking session for user:", req.user); // for debugging

    const sessionRef = db.collection("Sessions").doc(req.user.userId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      console.warn("🚨 No session found for user:", req.user.userId);
      return res.status(401).json({ error: "Session expired" });
    }

    const sessionData = sessionSnap.data();
    console.log("✅ Found session:", sessionData);

    if (!sessionData.lastActive) {
      console.warn("⚠️ Missing lastActive field in session data!");
      return res.status(500).json({ error: "Session data corrupted" });
    }

    // Remove the timeout check and return session data
    res.json({
      userId: req.user.userId,
      profile: req.user.profile,
      sessionData,
    });
  } catch (error) {
    console.error("❌ Internal Server Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
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

    // update cache
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
/*app.post("/verify-admin-password", async (req, res) => {
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
});*/

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
    const logsSnapshot = await db.collection("Logs").get();
    const logs = logsSnapshot.docs.map((doc) => {
      const logData = doc.data();

      if (logData.date && logData.date.toDate) {
        logData.date = logData.date.toDate();
      }
      return logData;
    });
    res.status(200).json(logs);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch logs" });
  }
});

//USERS LAYOUT

// get all users
app.get("/users", async (req, res) => {
  try {
    const usersSnapshot = await db.collection("User Informations").get();
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

    res.status(200).json(programsData);
  } catch (error) {
    console.error("Error fetching programs:", error);
    res.status(500).json({ message: "Error fetching programs" });
  }
});

//TRAINING PROGRAMS VIEW

app.get("/training-programs", async (req, res) => {
  try {
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);

    // fetch cached data if availabel
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
      .where("end_date", ">=", nowSeconds)
      .where("start_date", ">", nowSeconds)
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
    const [files] = await bucket.getFiles({ prefix: "carousel-images/" });

    const imageUrls = await Promise.all(
      files
        .filter((file) => {
          return file.name.match(/\.(jpg|jpeg|png|gif)$/i);
        })
        .map(async (file) => {
          const url = await file.getSignedUrl({
            action: "read",
            expires: "03-09-2491",
          });
          return { name: file.name, url: url[0] };
        })
    );

    res.status(200).json(imageUrls); // send img to frontend
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
    const adminUserId = "DVOAYL7n8eZ3EKkgXQ3f";
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

//DASHBOARD

app.get("/api/user-info-gender/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const userCollection = db.collection("User Informations");
    const querySnapshot = await userCollection
      .where("user_ID", "==", userId)
      .get();

    if (!querySnapshot.empty) {
      const userDoc = querySnapshot.docs[0].data();
      res
        .status(200)
        .json({ full_name: userDoc.full_name, gender: userDoc.gender });
    } else {
      res.status(404).json({ message: `No user found for userId: ${userId}` });
    }
  } catch (error) {
    console.error("Error fetching user gender:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/export-quota-report", async (req, res) => {
  try {
    // get training data
    const { trainingData } = req.body;
    if (!trainingData || trainingData.length === 0) {
      return res.status(400).json({ error: "No training data provided." });
    }

    // load template
    const filePath = path.join(
      __dirname,
      "public",
      "quota_report_template_final.xlsx"
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    // Get the first worksheet
    const worksheet = workbook.getWorksheet(1);

    // put data simula sa row 9
    let startRow = 9;
    trainingData.forEach((data, index) => {
      const row = worksheet.getRow(startRow + index);

      row.getCell(1).value = data["#"];
      row.getCell(2).value = data.TRAINING;
      row.getCell(3).value = data.LOCATION;
      row.getCell(4).value = data.PARTICIPANTS;
      row.getCell(5).value = data["TYPE OF TRAINING"];
      row.getCell(6).value = data["SPECIFIC TRAINING"];
      row.getCell(7).value = data.DATE;
      row.getCell(8).value = data.MONTH;
      row.getCell(9).value = data.MALE;
      row.getCell(10).value = data.FEMALE;
      row.getCell(11).value = data.TOTAL;
      row.getCell(12).value = data.REMARKS;

      const maxTextLength = Math.max(
        ...Object.values(data).map((value) => value?.toString().length || 0)
      );
      row.height = Math.max(15, Math.ceil(maxTextLength / 40) * 20);

      row.commit();
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Quota_Report.xlsx`
    );

    // modify edited file
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Error exporting quota report:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

app.get("/feedback-wordcloud", async (req, res) => {
  try {
    // Serve from cache if valid
    if (
      trainingProgramsCache &&
      cacheTimestamp &&
      Date.now() - cacheTimestamp < CACHE_DURATION
    ) {
      console.log("Serving training programs from cache");
      return res.status(200).json(trainingProgramsCache);
    }

    // Fetch all training programs
    const programsSnapshot = await db.collection("Training Programs").get();
    const programsData = [];

    for (const programDoc of programsSnapshot.docs) {
      const programData = {
        id: programDoc.id,
        ...programDoc.data(),
        feedbacks: [], // Ensure feedbacks always exist
      };

      // Fetch feedbacks from the "ratings" subcollection
      const ratingsSnapshot = await db
        .collection("Training Programs")
        .doc(programDoc.id)
        .collection("ratings")
        .get();

      ratingsSnapshot.forEach((ratingDoc) => {
        const ratingData = ratingDoc.data();
        if (ratingData.feedback) {
          programData.feedbacks.push(ratingData.feedback);
        }
      });

      programsData.push(programData);
    }

    // Ensure the response is an array
    if (!Array.isArray(programsData)) {
      throw new Error("Invalid response format");
    }

    // Update cache
    trainingProgramsCache = programsData;
    cacheTimestamp = Date.now();

    console.log("Serving fresh training programs data and updating cache");
    res.status(200).json(programsData);
  } catch (error) {
    console.error("Error fetching training programs:", error);
    res.status(500).json({ message: "Failed to fetch training programs" });
  }
});

//download certificate

app.post("/generate-certificate", (req, res) => {
  const { name, training, location, date, serialNumber } = req.body;

  const templatePath = path.join(__dirname, "Sample-Certificate.docx");
  const templateContent = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(templateContent);
  const doc = new Docxtemplater(zip);

  doc.setData({ name, training, location, date, serialNumber });

  try {
    doc.render();
    const outputBuffer = doc.getZip().generate({ type: "nodebuffer" });

    const outputPath = path.join(__dirname, "Completed-Certificate.docx");
    fs.writeFileSync(outputPath, outputBuffer);

    res.download(outputPath);
  } catch (error) {
    res.status(500).json({ error: "Error generating certificate" });
  }
});

//google api

const credentials = {
  type: "service_account",
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID,
  auth_uri: process.env.GOOGLE_AUTH_URI,
  token_uri: process.env.GOOGLE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_CERT_URL,
  client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
};

// authenticate serv acc
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);

/**
 * @param {Object} eventDetails
 */

const oauth2Client = new google.auth.OAuth2(
  process.env.CALENDAR_CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

function getAuthenticatedCalendar(tokens) {
  const authClient = new google.auth.OAuth2(
    process.env.CALENDAR_CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  authClient.setCredentials(tokens);
  return google.calendar({ version: "v3", auth: authClient });
}

app.get("/check-auth", (req, res) => {
  console.log("🔍 Checking authentication session...");
  console.log("Full Session Data:", req.session); // para sa hayop na debug

  if (req.session.tokens) {
    console.log("✅ User is authenticated. Tokens exist.");
    return res.json({ authenticated: true });
  }

  console.log("❌ No authentication tokens found.");
  res.json({ authenticated: false });
});

// Oauth screen
app.get("/auth/google", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    prompt: "consent",
  });

  res.redirect(authUrl);
});

// open google new window
app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    console.log("✅ Tokens received:", tokens);

    req.session.tokens = tokens;

    req.session.save((err) => {
      if (err) {
        console.error("❌ Error saving session:", err);
        return res.status(500).send("Session saving failed");
      }
      console.log("✅ Tokens saved in session:", req.session.tokens);
      res.send(`<script>window.close();</script>`);
    });
  } catch (error) {
    console.error("❌ Error retrieving access token:", error);
    res.status(500).send("Authentication failed");
  }
});

// sync google calendar
app.post("/sync-google-calendar", async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const { events } = req.body;
    if (!events || events.length === 0) {
      return res.status(400).json({ message: "No events provided" });
    }

    console.log(`📩 Syncing ${events.length} events to Google Calendar...`);

    const calendar = getAuthenticatedCalendar(req.session.tokens);

    // put all events from calendar
    const eventPromises = events.map((event) =>
      calendar.events.insert({
        calendarId: "primary",
        resource: {
          summary: event.title,
          location: event.location || "N/A",
          description: event.description,
          start: { dateTime: event.startTime, timeZone: "Asia/Manila" },
          end: { dateTime: event.endTime, timeZone: "Asia/Manila" },
        },
      })
    );

    await Promise.all(eventPromises);
    console.log(`✅ Successfully synced ${events.length} events`);
    res.status(200).json({ message: "Events synced successfully" });
  } catch (error) {
    console.error("❌ Error syncing events:", error);
    res.status(500).json({ message: "Failed to sync events", error });
  }
});

//attendance

app.post("/download-attendance", async (req, res) => {
  try {
    console.log("📥 Received request to generate attendance report");

    let { approvedApplicants, dateRange, program } = req.body;

    if (!approvedApplicants && program?.approved_applicants) {
      approvedApplicants = Object.values(program.approved_applicants);
    }

    if (!approvedApplicants || !dateRange || !program) {
      console.error("❌ Missing required data:");
      if (!approvedApplicants)
        console.error("⛔ approvedApplicants is missing!");
      if (!dateRange) console.error("⛔ dateRange is missing!");
      if (!program) console.error("⛔ program is missing!");
      return res.status(400).json({ error: "Missing required data" });
    }

    console.log(
      "🔍 Extracted approvedApplicants:",
      JSON.stringify(approvedApplicants, null, 2)
    );

    const userIds = approvedApplicants.map((applicant) => applicant.user_id);
    console.log("🔍 Querying Firestore for user details:", userIds);

    const userDetails = {};
    const userDocs = await db
      .collection("User Informations")
      .where("user_ID", "in", userIds)
      .get();

    userDocs.forEach((doc) => {
      userDetails[doc.data().user_ID] = doc.data();
    });

    console.log(
      "✅ Retrieved User Information:",
      JSON.stringify(userDetails, null, 2)
    );

    // only 5 dates are stored
    const formattedDates = dateRange.slice(0, 5).map((date, index) => {
      const validDate = new Date(date);
      if (isNaN(validDate.getTime())) {
        console.error("❌ Invalid date format detected:", date);
        throw new Error("Invalid date format received");
      }

      return {
        key: `date${index + 1}`,
        value: validDate.toLocaleDateString("en-CA"),
      };
    });

    console.log("✅ Fixed Formatted Dates:", formattedDates);

    const attendees = approvedApplicants.map((applicant, index) => {
      let remarks = {};

      formattedDates.forEach((dateObj, i) => {
        let status = "No Data";

        if (applicant.attendance) {
          for (const attendanceDate in applicant.attendance) {
            if (
              new Date(
                applicant.attendance[attendanceDate].date
              ).toLocaleDateString("en-CA") === dateObj.value
            ) {
              status = applicant.attendance[attendanceDate].remark;
              break;
            }
          }
        }

        remarks[`remark${i + 1}`] = status === "present" ? "Present" : "Absent";
      });
      //merge data here
      const userInfo = userDetails[applicant.user_id] || {};

      return {
        index: index + 1,
        full_name: applicant.full_name || "Unknown",
        gender: userInfo.gender || "N/A",
        age: userInfo.age || "N/A",
        civil_status: userInfo.civil_status || "N/A",
        cellphone_no: userInfo.mobile_number || "N/A",
        agency_office: userInfo.school_agency || "N/A",
        barangay: userInfo.barangay || "N/A",
        municipality: userInfo.municipality || "N/A",
        province: userInfo.province || "N/A",
        ...remarks,
      };
    });

    console.log("✅ Attendees Data:", JSON.stringify(attendees, null, 2));

    const templatePath = path.join(__dirname, "attendance_temp_final.docx");

    if (!fs.existsSync(templatePath)) {
      console.error("❌ Template file not found:", templatePath);
      return res.status(500).json({ error: "Template file not found" });
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip);

    // put data to template
    doc.setData({
      program_name: program.program_title || "Unknown Program",
      trainer_name: program.trainer_assigned || "Unknown Trainer",
      start_date: new Date(program.start_date * 1000).toLocaleDateString(),
      end_date: new Date(program.end_date * 1000).toLocaleDateString(),
      ...Object.fromEntries(
        formattedDates.map((dateObj) => [dateObj.key, dateObj.value])
      ),
      attendees: attendees,
    });

    doc.render();

    const buffer = doc.getZip().generate({ type: "nodebuffer" });
    const filePath = path.join(__dirname, "Attendance_Report.docx");
    fs.writeFileSync(filePath, buffer);

    console.log("📤 Sending file to frontend...");

    res.download(filePath, "Attendance_Report.docx", (err) => {
      if (err) {
        console.error("❌ Error sending file:", err);
        return res.status(500).send("Error downloading file");
      }
      fs.unlinkSync(filePath); // delete file after sending to frontend
      console.log("File successfully sent and deleted from server.");
    });
  } catch (error) {
    console.error("❌ An error occurred:", error);
    res
      .status(500)
      .send(`Error processing attendance report: ${error.message}`);
  }
});

//populate template

app.post("/populate-crf", upload.single("file"), async (req, res) => {
  console.log("Received Fields:", req.body);
  console.log("Received File:", req.file);

  console.log("Request received at /populate-crf");
  try {
    // Load DOCX template
    const templatePath = path.join(__dirname, "CRF_TEMP.docx");
    const templateBuffer = await readFile(templatePath);
    const zip = await JSZip.loadAsync(templateBuffer);

    // Extract XML content
    let docXml = await zip.file("word/document.xml").async("string");

    // Replace text fields
    const placeholders = {
      "[[FULL_NAME]]": req.body.full_name || "No value",
      "[[NICK_NAME]]": req.body.nickname || "No value",
      "[[BLOOD_TYPE]]": req.body.blood_type || "No value",
      "[[DATE_OF_BIRTH]]": req.body.date_of_birth || "No value",
      "[[AGE]]": req.body.age || "No value",
      "[[PLACE_OF_BIRTH]]": req.body.place_of_birth || "No value",
      "[[GENDER]]": req.body.gender || "No value",
      "[[CIVIL_STATUS]]": req.body.civil_status || "No value",
      "[[RELIGION]]": req.body.religion || "No value",
      "[[HN]]": req.body.house_number || "No value",
      "[[PK]]": req.body.purok || "No value",
      "[[ST]]": req.body.street || "No value",
      "[[BRGY]]": req.body.barangay || "No value",
      "[[MUNICIPALITY]]": req.body.municipality || "No value",
      "[[PROVINCE]]": req.body.province || "No value",
      "[[ZIP]]": req.body.zip || "No value",
      "[[LRN]]": req.body.deped_lrn || "No value",
      "[[PHILSYS_NUMBER]]": req.body.philsys_number || "No value",
      "[[HOUSEHOLD_HEAD]]": req.body.household_head || "No value",
      "[[TELEPHONE_NUMBER]]": req.body.telephone_number || "No value",
      "[[TELFAX]]": req.body.telfax_number || "No value",
      "[[MOBILE_NUMBER]]": req.body.mobile_number || "No value",
      "[[EMAIL]]": req.body.email || "No value",
      "[[SCHOOL_AGENCY]]": req.body.school_agency || "No value",
      "[[PROFESSION]]": req.body.profession_occupation || "No value",
      "[[POSITION]]": req.body.position || "No value",
    };

    for (const [key, value] of Object.entries(placeholders)) {
      const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // Escape special characters
      docXml = docXml.replace(new RegExp(safeKey, "g"), value);
    }

    zip.file("word/document.xml", docXml);

    // Force replace `image1.png` in `word/media/`
    const imagePath = "word/media/image3.png";
    if (zip.file(imagePath)) {
      console.log(`🔄 Replacing ${imagePath} with uploaded image.`);
      zip.file(imagePath, req.file.buffer); // Replace image with uploaded one
    } else {
      console.log(`❌ ${imagePath} not found in DOCX.`);
    }

    // Generate new DOCX
    const newDocxBuffer = await zip.generateAsync({ type: "nodebuffer" });

    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="CRF-Copy.docx"`,
    });
    res.send(newDocxBuffer);
  } catch (error) {
    console.error("❌ Error populating CRF template:", error);
    res.status(500).json({ message: "Failed to populate CRF template", error });
  }
});

//notifications

const sendNotificationToUser = async (title, body, userId) => {
  try {
    // Fetch the user's FCM token from the database
    const userDoc = await db.collection("Users").doc(userId).get();
    if (!userDoc.exists) {
      console.log("NOTIFICATION: No such user!");
      return;
    }

    const userData = userDoc.data();
    const token = userData.fcmToken;

    if (token) {
      const message = {
        data: {
          title, // Include the title in data
          body, // Include the body in data
        },
        token, // Send to the user's FCM token
      };

      // Send notification
      const response = await admin.messaging().send(message);
      console.log("Successfully sent message:", response);
    } else {
      console.log("No FCM token found for this user");
    }
  } catch (error) {
    console.error("Error sending notification:", error);
  }
};

const sendNotificationToAll = async (title, body) => {
  try {
    // Get all users and their FCM tokens
    const usersSnapshot = await db.collection("Users").get();
    const tokens = [];

    usersSnapshot.forEach((doc) => {
      const userData = doc.data();
      if (userData.fcmToken) {
        tokens.push(userData.fcmToken);
      }
    });

    if (tokens.length > 0) {
      // Iterate over tokens and send notifications one by one
      const promises = tokens.map(async (token) => {
        const message = {
          notification: {
            title,
            body,
          },
          token, // Send to the user's FCM token
        };

        // Send notification to this token
        try {
          const response = await admin.messaging().send(message);
          console.log("Successfully sent message to user:", response);
        } catch (error) {
          console.error("Error sending message to token:", token, error);
        }
      });

      // Wait for all notifications to be sent
      await Promise.all(promises);
      console.log("All notifications have been sent");
    } else {
      console.log("No FCM tokens found for any users");
    }
  } catch (error) {
    console.error("Error sending notification to all users:", error);
  }
};

// send notification to a specific user
app.post("/send-notification", async (req, res) => {
  const { title, body, userId } = req.body;

  try {
    await sendNotificationToUser(title, body, userId);
    res.status(200).send({ message: "Notification sent successfully" });
  } catch (error) {
    res.status(500).send({ error: "Failed to send notification" });
  }
});

// send notification to all users
app.post("/send-notification-to-all", async (req, res) => {
  const { title, body } = req.body;

  try {
    await sendNotificationToAll(title, body);
    res
      .status(200)
      .send({ message: "Notification sent to all users successfully" });
  } catch (error) {
    res.status(500).send({ error: "Failed to send notification to all users" });
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
