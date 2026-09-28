function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,Idempotency-Key",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const raw = await readRawBody(req, 1024 * 1024);
  try {
    const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "请求需要有效的JSON对象");
  }
}

function readRawBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readMultipartForm(req) {
  const contentType = req.headers["content-type"] || "";
  const body = await readRawBody(req);
  const fields = {};
  const files = [];
  try {
    const form = await new Response(body, {
      headers: { "Content-Type": contentType },
    }).formData();
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") fields[name] = value;
      else
        files.push({
          fieldName: name,
          fileName: value.name,
          buffer: Buffer.from(await value.arrayBuffer()),
        });
    }
  } catch {
    throw new HttpError(400, "上传格式不正确，请重新选择文件");
  }
  return { fields, files };
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = {
  sendJson,
  readJsonBody,
  readMultipartForm,
  HttpError,
};
