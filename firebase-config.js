const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Firebase configuration for bgeno-8ec4c project
const firebaseConfig = {
    apiKey: "AIzaSyB38YwGa3Cl5omQWlQpDIEzAAlnCzep78o",
    authDomain: "bgeno-8ec4c.firebaseapp.com",
    projectId: "bgeno-8ec4c",
    storageBucket: "bgeno-8ec4c.firebasestorage.app",
    messagingSenderId: "589852176857",
    appId: "1:589852176857:web:2ccc846caf867733fc69c8",
    measurementId: "G-PKVH1XPX3B"
};

// Initialize Firebase Admin SDK with service account credentials
try {
    // Check if we have service account credentials
    if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        // Properly format the private key
        let privateKey = process.env.FIREBASE_PRIVATE_KEY;

        // Remove quotes if they exist
        if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
            privateKey = privateKey.slice(1, -1);
        }

        // Replace literal \n with actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');

        // Ensure the key starts and ends with proper PEM format
        if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
            throw new Error('Invalid private key format');
        }

        const serviceAccount = {
            type: "service_account",
            project_id: firebaseConfig.projectId,
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            private_key: privateKey,
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: "https://accounts.google.com/o/oauth2/auth",
            token_uri: "https://oauth2.googleapis.com/token",
            auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
            client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
        };

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com`,
            projectId: firebaseConfig.projectId
        });
        console.log('✅ Firebase Admin SDK initialized successfully with service account credentials');
    } else {
        // Fallback to default credentials
        admin.initializeApp({
            credential: admin.credential.applicationDefault(),
            databaseURL: `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com`,
            projectId: firebaseConfig.projectId
        });
        console.log('⚠️ Firebase Admin SDK initialized with default credentials (service account not configured)');
    }
} catch (error) {
    console.error('❌ Error initializing Firebase Admin SDK:', error.message);
    console.log('⚠️ Firebase Admin SDK already initialized or using default credentials');
}

// Initialize Firestore
const db = admin.firestore();

module.exports = { admin, db, firebaseConfig }; 