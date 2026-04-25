const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pino = require("pino");
const { Storage } = require('megajs');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const router = express.Router();

// MEGA config from env
const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;

// Helper: Remove session folder
function removeFile(FilePath) {
  if (!fs.existsSync(FilePath)) return false;
  fs.rmSync(FilePath, { recursive: true, force: true });
  return true;
}

// Helper: Upload to MEGA
async function uploadToMega(filePath, fileName) {
  if (!MEGA_EMAIL || !MEGA_PASSWORD) {
    console.log('MEGA credentials not set, skipping cloud upload');
    return null;
  }
  
  try {
    const storage = new Storage({
      email: MEGA_EMAIL,
      password: MEGA_PASSWORD
    });
    
    await storage.ready;
    const fileBuffer = fs.readFileSync(filePath);
    const file = await storage.upload(fileName, fileBuffer).complete;
    return file.link;
  } catch (err) {
    console.error('MEGA upload failed:', err.message);
    return null;
  }
}

// Main pairing route
router.get('/', async (req, res) => {
  const num = req.query.number;
  
  if (!num) {
    return res.status(400).json({ 
      success: false, 
      error: 'Phone number required. Format: 27634988678' 
    });
  }

  // Unique session folder per request
  const sessionId = uuidv4();
  const sessionPath = `./sessions/session-${sessionId}`;

  async function MegaMdPair() {
    try {
      // Ensure sessions directory exists
      if (!fs.existsSync('./sessions')) {
        fs.mkdirSync('./sessions', { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

      const MegaMdEmpire = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
      });

      // Handle pairing
      if (!MegaMdEmpire.authState.creds.registered) {
        await delay(1500);
        const cleanNum = num.replace(/[^0-9]/g, '');
        
        if (cleanNum.length < 10) {
          removeFile(sessionPath);
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid phone number. Include country code (e.g. 27634988678)' 
          });
        }

        const code = await MegaMdEmpire.requestPairingCode(cleanNum);
        
        if (!res.headersSent) {
          return res.json({ 
            success: true, 
            code: code,
            message: 'Enter this code in WhatsApp > Linked Devices > Link with phone number',
            sessionId: sessionId
          });
        }
      }

      // Connection handler
      MegaMdEmpire.ev.on('creds.update', saveCreds);
      
      MegaMdEmpire.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          await delay(5000);
          
          try {
            const credsPath = path.join(sessionPath, 'creds.json');
            
            if (!fs.existsSync(credsPath)) {
              console.error('creds.json not found');
              return;
            }

            const sessionMegaMD = fs.readFileSync(credsPath);
            
            // Upload to MEGA if configured
            const megaLink = await uploadToMega(credsPath, `creds-${sessionId}.json`);
            
            // Send to user's WhatsApp
            const MegaMds = await MegaMdEmpire.sendMessage(
              MegaMdEmpire.user.id, 
              { 
                document: sessionMegaMD, 
                mimetype: 'application/json', 
                fileName: `creds-${sessionId}.json` 
              }
            );

            // Send confirmation message
            await MegaMdEmpire.sendMessage(
              MegaMdEmpire.user.id,
              {
                text: `> *EXPLORE-MD-BOTS SESSION ID OBTAINED SUCCESSFULLY ✅*\n\n` +
                      `📁 Upload the creds.json file to your bot's session folder.\n\n` +
                      `${megaLink ? `☁️ MEGA Backup: ${megaLink}\n\n` : ''}` +
                      `*🔒 Do NOT share this session file with anyone.*\n\n` +
                      `> _Powered by REDDRAGON_`,
                contextInfo: {
                  externalAdReply: {
                    title: "Session Generated",
                    body: "EXPLORE-MD-PAIR",
                    thumbnailUrl: "https://i.imgur.com/placeholder.jpg",
                    sourceUrl: "https://github.com/LMK360/EXPLORE-MD-PAIR",
                    mediaType: 1,
                    renderLargerThumbnail: true
                  }
                }
              },
              { quoted: MegaMds }
            );

            // Cleanup
            await delay(1000);
            removeFile(sessionPath);
            
          } catch (err) {
            console.error('Session handling error:', err);
            removeFile(sessionPath);
          }
        } 
        else if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          
          if (shouldReconnect) {
            await delay(10000);
            MegaMdPair();
          } else {
            removeFile(sessionPath);
          }
        }
      });

    } catch (err) {
      console.error('Pairing error:', err);
      removeFile(sessionPath);
      
      if (!res.headersSent) {
        return res.status(503).json({ 
          success: false, 
          error: 'Service temporarily unavailable. Please try again.' 
        });
      }
    }
  }

  return await MegaMdPair();
});

// Graceful error handling
process.on('uncaughtException', function (err) {
  const e = String(err);
  const ignoreList = [
    "conflict",
    "Socket connection timeout",
    "not-authorized",
    "rate-overlimit",
    "Connection Closed",
    "Timed Out",
    "Value not found",
    "Bad MAC",
    "stream errored"
  ];
  
  if (ignoreList.some(ignore => e.includes(ignore))) return;
  console.log('Caught exception: ', err);
});

process.on('unhandledRejection', (reason) => {
  console.log('Unhandled rejection:', reason);
});

module.exports = router;
