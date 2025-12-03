// src/Chat.jsx
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";
const socket = io(BACKEND, { autoConnect: true });

export default function Chat() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [partnerId, setPartnerId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const messagesRef = useRef([]);
  messagesRef.current = messages;

  useEffect(() => {
    // connection
    socket.on("connect", () => {
      setConnected(true);
      setStatus("Connected to signaling server");
      console.log("socket connected", socket.id);
    });

    socket.on("disconnect", (reason) => {
      setConnected(false);
      setStatus("Disconnected from server");
      setPartnerId(null);
      console.log("socket disconnected", reason);
    });

    // server status updates (waiting, idle, etc)
    socket.on("status", (payload) => {
      if (payload && payload.state) {
        setStatus(payload.state);
      }
    });

    // matched with a partner
    socket.on("matched", ({ partnerId: pid }) => {
      setPartnerId(pid);
      setMessages([]);
      setStatus("Matched! Connected to stranger");
    });

    // text message from server (forwarded from partner)
    socket.on("text-message", ({ from, text, ts }) => {
      setMessages((m) => [...m, { from, text, ts }]);
    });

    // partner left or disconnected
    socket.on("partner-left", () => {
      setStatus("Partner left");
      setPartnerId(null);
      // optional: keep messages, or clear, or show button to find again
    });

    // reported / ack (optional)
    socket.on("report-ack", (data) => {
      console.log("report ack", data);
    });

    // cleanup on unmount
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("status");
      socket.off("matched");
      socket.off("text-message");
      socket.off("partner-left");
      socket.off("report-ack");
    };
  }, []);

  // Start searching for a partner (matches backend's 'find')
  const startChat = () => {
    socket.emit("find"); // <-- matches server.js
    setStatus("Searching for a stranger...");
  };

  // Cancel search (matches backend's 'cancel')
  const cancelSearch = () => {
    socket.emit("cancel");
    setStatus("Idle");
  };

  // Leave current chat (matches backend's 'leave')
  const endChat = () => {
    socket.emit("leave");
    setPartnerId(null);
    setStatus("Left chat");
  };

  // Send a text message (matches backend's 'text-message')
  const sendMessage = () => {
    if (!input.trim()) return;
    if (!partnerId) {
      // If not matched, do nothing (or show alert)
      setStatus("Not connected to any stranger");
      return;
    }
    // emit with payload { to, text } as backend expects
    socket.emit("text-message", { to: partnerId, text: input });
    // locally show message
    setMessages((m) => [...m, { from: "me", text: input, ts: Date.now() }]);
    setInput("");
  };

  return (
    <div style={styles.container}>
      <h2 style={{ textAlign: "center" }}>Random Chat (Anonymous)</h2>
      <p style={{ textAlign: "center", color: "gray" }}>{status}</p>

      <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
        {!partnerId && (
          <>
            <button onClick={startChat} style={styles.button}>
              Find Stranger
            </button>
            <button onClick={cancelSearch} style={styles.ghostButton}>
              Cancel
            </button>
          </>
        )}

        {partnerId && (
          <button onClick={endChat} style={styles.endButton}>
            Leave Chat
          </button>
        )}
      </div>

      <div style={styles.chatBox} id="chatBox">
        {messages.length === 0 && <div style={{ color: "#666" }}>No messages yet</div>}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.message,
              alignSelf: m.from === "me" ? "flex-end" : "flex-start",
              background: m.from === "me" ? "#DCF8C6" : "#fff",
            }}
          >
            <div style={{ fontSize: 12, color: "#666" }}>{m.from === "me" ? "You" : m.from}</div>
            <div>{m.text}</div>
            <div style={{ fontSize: 10, color: "#999", marginTop: 6 }}>
              {new Date(m.ts || Date.now()).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>

      <div style={styles.inputArea}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={partnerId ? "Type a message..." : "Find a stranger first"}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
          disabled={!partnerId}
        />
        <button onClick={sendMessage} style={styles.sendBtn} disabled={!partnerId}>
          Send
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: { maxWidth: 600, margin: "20px auto", display: "flex", flexDirection: "column", gap: 12 },
  chatBox: {
    height: 420,
    border: "1px solid #ccc",
    padding: 12,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    background: "#f7f7f7",
  },
  inputArea: { display: "flex", gap: 8, marginTop: 8 },
  input: { flex: 1, padding: "10px", borderRadius: 6, border: "1px solid #ccc" },
  sendBtn: { padding: "10px 14px", borderRadius: 6, border: "none", background: "#2563eb", color: "#fff" },
  button: { padding: "8px 12px", borderRadius: 6, border: "none", background: "#10b981", color: "white" },
  ghostButton: { padding: "8px 12px", borderRadius: 6, border: "1px solid #ccc", background: "white" },
  endButton: { padding: "8px 12px", borderRadius: 6, border: "none", background: "#ef4444", color: "white" },
  message: { padding: 10, borderRadius: 8, maxWidth: "75%", boxShadow: "0 1px 0 rgba(0,0,0,0.03)" },
};
