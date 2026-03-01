const http = require("http");
const fs = require("fs");

const PORT = 8080;
const KC_CLIENT_ID = process.env.KC_CLIENT_ID || "system:serviceaccount:ns-a:sa-client";
const KC_TOKEN_URL = process.env.KC_TOKEN_URL || "http://keycloak.keycloak.svc/realms/master/protocol/openid-connect/token";
const CLOUD_MANAGER_SERVICE_URL = process.env.CLOUD_MANAGER_SERVICE_URL || "http://cloud-manager.cloud-manager.svc/";
const SA_TOKEN_PATH = process.env.SA_TOKEN_PATH || "/var/run/secrets/tokens/keycloak-token";
const GRANT_TYPE = process.env.GRANT_TYPE || "client_credentials";
const CLIENT_ASSERTION_TYPE = process.env.CLIENT_ASSERTION_TYPE || "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
// Read the Kubernetes service account token
function readSAToken() {
  console.log("[readSAToken] Reading from:", SA_TOKEN_PATH);
  try {
    const token = fs.readFileSync(SA_TOKEN_PATH, "utf8").trim();
    console.log("[readSAToken] ✓ Token read, length:", token.length);
    return token;
  } catch (e) {
    console.error("[readSAToken] ✗ Error:", e.message);
    throw e;
  }
}

// Request an access token from Keycloak
async function getKeycloakToken() {
  console.log("[getKeycloakToken] Requesting token from:", KC_TOKEN_URL);
  const saToken = readSAToken();
  console.log("[getKeycloakToken] SA Token length:", saToken.length);

  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    client_id: KC_CLIENT_ID,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: saToken,
  });

  try {
    const res = await fetch(KC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[getKeycloakToken] Keycloak error:", res.status, err);
      throw new Error(`Keycloak error ${res.status}: ${err}`);
    }

    const data = await res.json();
    console.log("[getKeycloakToken] ✓ Token obtained, expires in:", data.expires_in);
    return data.access_token;
  } catch (e) {
    console.error("[getKeycloakToken] Exception:", e.message);
    throw e;
  }
}

// Call Cloud Manager Service
async function callCloudManagerService(token, url) {
  const fullUrl = CLOUD_MANAGER_SERVICE_URL + url;
  console.log("[callCloudManagerService] POST", fullUrl);
  
  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("[callCloudManagerService] Response status:", res.status);
    
    if (!res.ok) {
      const err = await res.text();
      console.error("[callCloudManagerService] Error response:", res.status, err);
      throw new Error(`Service error ${res.status}: ${err}`);
    }

    const data = await res.json();
    console.log("[callCloudManagerService] ✓ Success");
    return data;
  } catch (e) {
    console.error("[callCloudManagerService] Exception:", e.message);
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // Health check
  if (req.url === "/health") {
    res.end(JSON.stringify({ status: "ok", client: KC_CLIENT_ID }));
    return;
  }

  // Check the service account token (for debugging)
  if (req.url === "/token-info") {
    try {
      const token = readSAToken();
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      res.end(JSON.stringify({ sub: payload.sub, aud: payload.aud, iss: payload.iss }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Issue a Keycloak token -> call Cloud Manager Service
  // Proxy requests to cloud-manager-service endpoints
  if (["/upload", "/batch"].includes(req.url)) {
    console.log(`[${req.url}] Request received`);
    try {
      console.log(`[${req.url}] Getting Keycloak token...`);
      const token = await getKeycloakToken();
      console.log(`[${req.url}] Token obtained, calling service...`);
      const result = await callCloudManagerService(token, req.url);
      console.log(`[${req.url}] ✓ Success`);
      res.end(JSON.stringify({ client: KC_CLIENT_ID, cloudManagerService: result }));
    } catch (e) {
      console.error(`[${req.url}] ✗ Error:`, e.message);
      res.statusCode = 500;
      res.end(JSON.stringify({ client: KC_CLIENT_ID, error: e.message }));
    }
    return;
  }

  res.end(JSON.stringify({
    client: KC_CLIENT_ID,
    endpoints: ["/health", "/token-info", "/call", "/upload", "/batch"],
  }));
});

server.listen(PORT, () => {
  console.log(`\n🚀 Client started`);
  console.log(`📍 Client ID: ${KC_CLIENT_ID}`);
  console.log(`🔐 Keycloak: ${KC_TOKEN_URL}`);
  console.log(`💾 SA Token: ${SA_TOKEN_PATH}`);
  console.log(`📤 Cloud Manager: ${CLOUD_MANAGER_SERVICE_URL}`);
  console.log(`🎧 Listening on port ${PORT}\n`);
});
