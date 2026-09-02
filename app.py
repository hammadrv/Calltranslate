import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))


class HelloHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = b"hello\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.client_address[0]} - {format % args}", flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), HelloHandler)
    print(f"Serving on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
