const admin = require('firebase-admin');

// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyCY22Y4qXG5EVww8E79wdpydYVCb7c4oXM",
    authDomain: "geno-5e7f5.firebaseapp.com",
    databaseURL: "https://geno-5e7f5-default-rtdb.firebaseio.com",
    projectId: "geno-5e7f5",
    storageBucket: "geno-5e7f5.firebasestorage.app",
    messagingSenderId: "943090926739",
    appId: "1:943090926739:web:1e231ee60abe9034a43966",
    measurementId: "G-6J8RM6R0KQ"
};

// Initialize Firebase Admin SDK
// For production, you should use service account credentials
// For now, we'll use the default credentials
try {
    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        databaseURL: firebaseConfig.databaseURL,
        projectId: firebaseConfig.projectId
    });
    console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
    console.log('⚠️ Firebase Admin SDK already initialized or using default credentials');
}

// Initialize Firestore
const db = admin.firestore();

module.exports = { admin, db, firebaseConfig }; 