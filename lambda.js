// AWS Lambda entry point (Function URL with response streaming, behind CloudFront).
// Needs the Node.js 20 runtime, which provides the global `awslambda` helper and the AWS SDK v3.
import { EventEmitter } from 'node:events';
import { createApp } from './app.js';

const app = createApp({ serveStatic: false });

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const http = event.requestContext.http;
  const req = Object.assign(new EventEmitter(), {
    url: event.rawPath + (event.rawQueryString ? '?' + event.rawQueryString : ''),
    method: http.method,
    headers: event.headers || {},
    socket: { remoteAddress: http.sourceIp },
  });
  let stream = null;
  const res = {
    get headersSent() { return stream !== null; },
    writeHead(statusCode, headers) { stream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers }); },
    write(chunk) { return stream.write(chunk); },
    end(chunk) { if (chunk !== undefined) stream.write(chunk); stream.end(); },
  };
  await app.handle(req, res);
  if (!stream) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"No response"}'); }
});
