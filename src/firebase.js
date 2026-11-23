import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyAmOYaCC8du903_Et_SfITxLxvrnAEROKU",
  authDomain: "goldstar-9e03b.firebaseapp.com",
  projectId: "goldstar-9e03b",
  storageBucket: "goldstar-9e03b.firebasestorage.app",
  messagingSenderId: "786421674823",
  appId: "1:786421674823:web:4a65b3fa0550c180bcd262"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
