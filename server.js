const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const app = express();
const bcrypt = require('bcrypt');
const { getStorage, ref, listAll, getDownloadURL } = require('firebase-admin/storage');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config()

//caching
let trainingProgramsCache = null;
let ratedtrainingProgramsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000;

// Set up the HTTP server for Express
const server = http.createServer(app);

// Set up WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!allowedOrigins.includes(origin)) {
    ws.close();
    console.log('WebSocket connection rejected due to origin mismatch');
    return;
  }
  console.log('WebSocket connection established');
});



app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  })
);


app.use(express.json());
const serviceAccount = require('./firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = admin.firestore();
const storage = admin.storage();
const bucket = storage.bucket();

const PORT = process.env.PORT || 5000;
const allowedOrigins = [
  process.env.REACT_APP_ORIGIN,
  'http://localhost:3000',
];

// ENGAGEMENT LAYOUT

//get engagement data
app.get('/api/engagements', async (req, res) => {
  try {
    const currentTime = Date.now();

    // check if cached data is available and valid
    if (ratedtrainingProgramsCache && cacheTimestamp && currentTime - cacheTimestamp < CACHE_DURATION) {
      console.log('Serving from cache');
      return res.json(ratedtrainingProgramsCache);
    }

    console.log('Fetching data from Firestore');
    const programsSnapshot = await db.collection('Training Programs').get();
    const ratedProgramsData = [];

    for (const programDoc of programsSnapshot.docs) {
      const programId = programDoc.id;
      const programData = programDoc.data();
      const ratingsSnapshot = await db.collection('Training Programs')
        .doc(programId)
        .collection('ratings')
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
        const overallAverage = (averageProgramRating + averageTrainerRating) / 2;

        ratedProgramsData.push({
          id: programId,
          program_title: programData.program_title || 'No Title',
          trainer_assigned: programData.trainer_assigned || 'No Trainer',
          type: programData.type || 'Undefined',
          ratingCount,
          averageRating: parseFloat(overallAverage.toFixed(2)),
          thumbnail: programData.thumbnail || 'https://via.placeholder.com/100',
        });
      }
    }

    // update cache with new data
    ratedtrainingProgramsCache = ratedProgramsData;
    cacheTimestamp = currentTime;

    res.json(ratedProgramsData);
  } catch (error) {
    console.error("Error fetching ratings:", error);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});



// SETTINGS LAYOUT

//verify admin password
app.post('/verify-admin-password', async (req, res) => {
  const { userId, password } = req.body;

  try {
    const adminDocRef = db.collection('Users').doc(userId);
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
    console.error('Error verifying password:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

//add new admin
app.post('/add-admin', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const hashedPassword = bcrypt.hashSync(password, 10);

    await db.collection('Users').add({
      name,
      email,
      password: hashedPassword,
      profile: 'admin', 
    });

    res.status(201).json({ message: 'Admin added successfully' });
  } catch (error) {
    console.error('Error adding admin:', error);
    res.status(500).json({ message: 'Failed to add admin' });
  }
});

//get logs
app.get('/logs', async (req, res) => {
  try {
    const logsSnapshot = await db.collection('Logs').get();  // Using Admin SDK method
    const logs = logsSnapshot.docs.map(doc => {
      const logData = doc.data();
      
      if (logData.date && logData.date.toDate) {
        logData.date = logData.date.toDate();  // Convert Firestore Timestamp to JS Date
      }
      return logData;
    });
    res.status(200).json(logs);  // Sending logs as a response
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch logs' });
  }
});

//USERS LAYOUT

// get all users
app.get('/users', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('User Informations').get(); // Use Admin SDK method
    const usersData = usersSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(usersData);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});


// TRAINING PROGRAMS (ADMIN)

app.get('/programs', async (req, res) => {
  try {
    const querySnapshot = await db.collection('Training Programs').get();
    const programsData = querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json(programsData);  // Send the programs data as a response
  } catch (error) {
    console.error('Error fetching programs:', error);
    res.status(500).json({ message: 'Error fetching programs' });
  }
});


//TRAINING PROGRAMS VIEW (USER)

// get training programs for cards
app.get('/training-programs', async (req, res) => {
  try {
    const now = Date.now();
    if (trainingProgramsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
      console.log('Serving data from cache');
      return res.status(200).json(trainingProgramsCache); 
    }

    const programsSnapshot = await db.collection('Training Programs').get();
    const programsData = programsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    trainingProgramsCache = programsData;
    cacheTimestamp = Date.now();

    console.log('Serving data from Firestore and updating cache');
    res.status(200).json(programsData); 
  } catch (error) {
    console.error('Error fetching training programs:', error);
    res.status(500).json({ message: 'Failed to fetch training programs' });
  }
});


//TRAINING PROGRAMS VIEW (VISITOR)

app.get('/training-programs', async (req, res) => {
  try {
    const now = Date.now();
    // Serve from cache if data is still fresh
    if (trainingProgramsCache && cacheTimestamp && (now - cacheTimestamp < CACHE_DURATION)) {
      console.log('Serving training programs from cache');
      return res.status(200).json(trainingProgramsCache);
    }

    // If cache is invalid, fetch fresh data from Firestore
    const programsSnapshot = await db.collection('Training Programs').get();
    const programsData = programsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Update the cache
    trainingProgramsCache = programsData;
    cacheTimestamp = Date.now();

    console.log('Serving fresh training programs data and updating cache');
    res.status(200).json(programsData);
  } catch (error) {
    console.error('Error fetching training programs:', error);
    res.status(500).json({ message: 'Failed to fetch training programs' });
  }
});






// USERPANEL

//get user info
app.get('/api/user-info/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const userCollection = db.collection('User Informations');
    const querySnapshot = await userCollection.where('user_ID', '==', userId).get();

    if (!querySnapshot.empty) {
      const userDoc = querySnapshot.docs[0].data();
      res.status(200).json(userDoc);
    } else {
      res.status(404).json({ message: `No user information found for userId: ${userId}` });
    }
  } catch (error) {
    console.error('Error fetching user information:', error);
    res.status(500).json({ error: 'Error fetching user information' });
  }
});


//Carousel

app.get('/api/get-carousel-images', async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: 'carousel-images/' }); // List files in the 'carousel-images' folder
    const imageUrls = await Promise.all(
      files.map(async (file) => {
        const url = await file.getSignedUrl({ action: 'read', expires: '03-09-2491' }); // Generate signed URL for each file
        return { name: file.name, url: url[0] };
      })
    );
    res.status(200).json(imageUrls); // Send the image URLs to the frontend
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});









//Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

/*server.listen(5000, '0.0.0.0', () => {
  console.log("Server: Backend server is running on port 5000");
});*/