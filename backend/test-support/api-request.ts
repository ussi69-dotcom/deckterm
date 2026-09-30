/** Test client for authenticated API behavior. Browser-boundary tests deliberately
 * use the native Request instead, and verify missing/foreign header rejection. */
export class ApiRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    if (new URL(this.url).pathname.startsWith("/ws/"))
      this.headers.set("Origin", "http://localhost:4174");
    if (!["GET", "HEAD", "OPTIONS"].includes(this.method)) {
      this.headers.set("X-DeckTerm-Request", "1");
    }
  }
}
