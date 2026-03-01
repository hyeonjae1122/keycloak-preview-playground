const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const KC_INTROSPECT_URL =
  process.env.KC_INTROSPECT_URL ||  "";
const KC_INTROSPECT_CLIENT_ID = process.env.KC_INTROSPECT_CLIENT_ID || "";
const KC_INTROSPECT_CLIENT_SECRET = process.env.KC_INTROSPECT_CLIENT_SECRET || "";

const CLIENT_FILE_SERVICE = process.env.CLIENT_FILE_SERVICE || "";
const CLIENT_OPERATOR_SERVICE = process.env.CLIENT_OPERATOR_SERVICE || "";

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function getBearerToken(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    console.log("[getBearerToken] No Bearer token found");
    return null;
  }
  const token = auth.slice("Bearer ".length).trim();
  console.log("[getBearerToken] Token extracted, length:", token.length);
  return token;
}

async function introspectAccessToken(token) {
  console.log("[introspectAccessToken] POST to:", KC_INTROSPECT_URL);
  const body = new URLSearchParams({
    token,
    token_type_hint: "access_token",
    client_id: KC_INTROSPECT_CLIENT_ID,
    client_secret: KC_INTROSPECT_CLIENT_SECRET,
  });

  const res = await fetch(KC_INTROSPECT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[introspectAccessToken] Failed:", res.status, text);
    throw new Error(`Introspection failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log("[introspectAccessToken] Success, active:", data.active, "client_id:", data.client_id || data.azp || data.sub);
  return data;
}

function extractClientId(introspection) {
  return introspection.client_id || introspection.azp || introspection.sub || "unknown";
}

function isAllowedForPath(pathname, clientId) {
  if (pathname === "/upload") return clientId === CLIENT_FILE_SERVICE;
  if (pathname === "/batch") return clientId === CLIENT_OPERATOR_SERVICE;
  return false;
}

async function authenticate(req) {
  console.log("[authenticate] Starting authentication");
  const token = getBearerToken(req);
  if (!token) {
    console.warn("[authenticate] No token provided");
    return {
      ok: false,
      status: 401,
      error: "Missing Authorization header. Expected: Bearer <access_token>",
    };
  }

  let introspection;
  try {
    introspection = await introspectAccessToken(token);
  } catch (e) {
    console.error("[authenticate] Introspection error:", e.message);
    return { ok: false, status: 502, error: e.message };
  }

  if (!introspection.active) {
    console.warn("[authenticate] Token is not active");
    return { ok: false, status: 401, error: "Token is inactive or invalid" };
  }

  return {
    ok: true,
    clientId: extractClientId(introspection),
    tokenMeta: introspection,
  };
}

const server = http.createServer(async (req, res) => {
  const { method, url: rawUrl } = req;
  const pathname = (rawUrl || "").split("?")[0];
  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);

  if (method === "GET" && pathname === "/health") {
    return json(res, 200, {
      status: "ok",
      service: "server",
      endpoints: ["POST /upload", "POST /batch"],
    });
  }

  if (method === "POST" && (pathname === "/upload" || pathname === "/batch")) {
    const auth = await authenticate(req);
    if (!auth.ok) {
      console.warn("[POST handler] Auth failed:", auth.error);
      return json(res, auth.status, { error: auth.error });
    }
    console.log("[POST handler] Auth success, clientId:", auth.clientId);

    const allowed = isAllowedForPath(pathname, auth.clientId);
    if (!allowed) {
      console.warn("[POST handler] Access denied - client:", auth.clientId, "path:", pathname);
      return json(res, 403, {
        error: "Forbidden",
        path: pathname,
        client_id: auth.clientId,
      });
    }

    if (pathname === "/upload") {
      console.log("[POST /upload] ✓ Accepted from:", auth.clientId);
      return json(res, 200, {
        ok: true,
        path: "/upload",
        client_id: auth.clientId,
        message: "Mock upload API accepted",
      });
    }

    console.log("[POST /batch] ✓ Accepted from:", auth.clientId);
    return json(res, 200, {
      ok: true,
      path: pathname,
      client_id: auth.clientId,
      message: "Mock batch delete API accepted",
    });
  }

  return json(res, 404, {
    error: "Not found",
    endpoints: ["GET /health", "POST /upload", "POST /batch"],
  });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Server started`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🔐 Keycloak Introspect: ${KC_INTROSPECT_URL}`);
  console.log(`👤 File Service: ${CLIENT_FILE_SERVICE}`);
  console.log(`👤 Operator Service: ${CLIENT_OPERATOR_SERVICE}\n`);
});
