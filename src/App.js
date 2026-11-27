import { useEffect } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

import { initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import { getDatabase, ref, onValue, update, query, limitToLast } from "firebase/database";

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.REACT_APP_FIREBASE_DATABASE_URL,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const latestRef = ref(db, "gps_tracker/latest");

function App() {
  useEffect(() => {
    const $ = (id) => document.getElementById(id);

    const map = L.map("map").setView([20.5937, 78.9629], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);

    const icon = (color) => L.divIcon({
      className: "",
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.6)"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    let meMarker = null;
    let accCircle = null;
    let alertMarker = null;
    let myPos = null;
    let firstFix = true;
    let lastPressId = null;
    let pendingAlert = null;
    let alarmCtx = null;
    let alarmTimer = null;
    let geolocationWatch = null;
    const unsubscribes = [];

    function onPosition(p) {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
      $("lat").textContent = myPos.lat.toFixed(6);
      $("lng").textContent = myPos.lng.toFixed(6);
      $("acc").textContent = `±${Math.round(p.coords.accuracy)} m`;

      if (!meMarker) {
        meMarker = L.marker(myPos, { icon: icon("#3b82f6") }).addTo(map).bindPopup("You");
      } else {
        meMarker.setLatLng(myPos);
      }

      if (!accCircle) {
        accCircle = L.circle(myPos, { radius: p.coords.accuracy, color: "#3b82f6", weight: 1 }).addTo(map);
      } else {
        accCircle.setLatLng(myPos).setRadius(p.coords.accuracy);
      }

      if (firstFix) {
        map.setView(myPos, 18);
        firstFix = false;
      }

      if (pendingAlert) {
        placeAlertMarker(pendingAlert);
        pendingAlert = null;
      }
    }

    function placeAlertMarker(timeText) {
      if (!myPos) {
        pendingAlert = timeText;
        return;
      }
      if (!alertMarker) {
        alertMarker = L.marker(myPos, { icon: icon("#ef4444") }).addTo(map);
      } else {
        alertMarker.setLatLng(myPos);
      }
      alertMarker.bindPopup(`🚨 Alert received here<br>${timeText}`).openPopup();
      map.setView(myPos, 18);
    }

    function stopAlarm() {
      clearInterval(alarmTimer);
      alarmTimer = null;
    }

    function startAlarm() {
      if (!alarmCtx) return;
      stopAlarm();
      const beep = () => {
        const o = alarmCtx.createOscillator();
        const g = alarmCtx.createGain();
        o.type = "square";
        o.frequency.value = 880;
        g.gain.value = 0.15;
        o.connect(g);
        g.connect(alarmCtx.destination);
        o.start();
        o.stop(alarmCtx.currentTime + 0.3);
        if (navigator.vibrate) navigator.vibrate(300);
      };
      beep();
      alarmTimer = setInterval(beep, 700);
    }

    function setAlert(on) {
      $("statusCard").classList.toggle("alert", on);
      $("statusIcon").textContent = on ? "🚨" : "✅";
      $("statusTitle").textContent = on ? "BUTTON PRESSED – child needs help!" : "Child is OK";
      $("statusText").textContent = on
        ? "The child's watch button was pressed. Check the map and go to the child."
        : "No button press received.";
    }

    function handleLatest(d) {
      if (!d) return;
      const pressed = d.pressed === true;
      setAlert(pressed);

      const when = d.pressed_at ? new Date(d.pressed_at).toLocaleTimeString() : "—";
      $("time").textContent = when;
      $("rssi").textContent = d.wifi_rssi != null ? `${d.wifi_rssi} dBm` : "—";

      if (pressed) {
        if (d.pressed_at !== lastPressId) {
          lastPressId = d.pressed_at;
          startAlarm();
          placeAlertMarker(when);
        }
      } else {
        stopAlarm();
      }
    }

    function renderHistory(snapshot) {
      const items = [];
      snapshot.forEach((child) => items.push(child.val()));
      items.reverse();
      $("history").innerHTML = items.length
        ? items.map((item) => `<li>🚨 ${item.pressed_at ? new Date(item.pressed_at).toLocaleString() : "—"}</li>`).join("")
        : "<li>No history yet</li>";
    }

    $("startBtn").addEventListener("click", startTracking);

    function startTracking() {
      alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
      alarmCtx.resume();

      if (!navigator.geolocation) {
        alert("Geolocation not supported on this device");
        return;
      }

      geolocationWatch = navigator.geolocation.watchPosition(
        onPosition,
        (error) => alert("Location error: " + error.message),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );

      $("startBtn").textContent = "✔ Tracking enabled";
      $("startBtn").disabled = true;
    }

    $("resetBtn").addEventListener("click", resetAlert);

    function resetAlert() {
      stopAlarm();
      update(latestRef, { pressed: false });
    }

    signInWithEmailAndPassword(
      auth,
      process.env.REACT_APP_FIREBASE_EMAIL,
      process.env.REACT_APP_FIREBASE_PASSWORD
    )
      .then(() => {
        $("conn").textContent = "Connected";
        $("conn").className = "pill ok";
        unsubscribes.push(onValue(
          latestRef,
          (snapshot) => handleLatest(snapshot.val()),
          (error) => {
            $("conn").textContent = "Database denied";
            $("conn").className = "pill bad";
            console.error("Latest listener error:", error);
          }
        ));
        unsubscribes.push(onValue(
          query(ref(db, "gps_tracker/history"), limitToLast(5)),
          renderHistory,
          (error) => {
            $("history").innerHTML = "<li>Unable to load history</li>";
            console.error("History listener error:", error);
          }
        ));
      })
      .catch((error) => {
        $("conn").textContent = "Login failed";
        $("conn").className = "pill bad";
        console.error(error);
      });

    return () => {
      stopAlarm();
      if (geolocationWatch !== null) navigator.geolocation.clearWatch(geolocationWatch);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      map.remove();
      $("startBtn")?.removeEventListener("click", startTracking);
      $("resetBtn")?.removeEventListener("click", resetAlert);
    };
  }, []);

  return (
    <>
      <header>
        <h1>🦁 Zoo Child Finder</h1>
        <span id="conn" className="pill">Connecting…</span>
      </header>
      <main>
        <section id="statusCard" className="card">
          <div className="status-icon" id="statusIcon">✅</div>
          <div>
            <h2 id="statusTitle">Child is OK</h2>
            <p id="statusText">No button press received.</p>
          </div>
        </section>
        <button id="startBtn" className="btn primary">▶ Start tracking (enable my location + alarm)</button>
        <section className="card">
          <h3>📍 Live Map</h3>
          <div id="map"></div>
          <div className="legend">
            <span><i className="dot red"></i> Alert received here</span>
            <span><i className="dot blue"></i> You</span>
          </div>
        </section>
        <section className="card">
          <h3>Details</h3>
          <div className="grid">
            <div><small>Last alert</small><b id="time">—</b></div>
            <div><small>Watch Wi-Fi signal</small><b id="rssi">—</b></div>
            <div><small>My latitude</small><b id="lat">—</b></div>
            <div><small>My longitude</small><b id="lng">—</b></div>
            <div><small>GPS accuracy</small><b id="acc">—</b></div>
          </div>
          <div className="actions">
            <button id="resetBtn" className="btn">Reset alert</button>
          </div>
        </section>
        <section className="card">
          <h3>Recent alerts</h3>
          <ul id="history"><li>No history yet</li></ul>
        </section>
      </main>
    </>
  );
}

export default App;