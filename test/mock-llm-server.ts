import * as http from "node:http";

export interface MockServerInstance {
  server: http.Server;
  /**
   * Actual bound port. Pass port=0 to let the OS pick a free one, which
   * removes fixed-port collisions as a flake source.
   */
  actualPort: number;
  receivedBodies: Array<Record<string, unknown>>;
  getLastReceivedMessages(): Array<Record<string, unknown>>;
  clearHistory(): void;
  close(): Promise<void>;
}

export function startMockOpenAiServer(port = 0): Promise<MockServerInstance> {
  const { promise, resolve } = Promise.withResolvers<MockServerInstance>();
  const receivedBodies: Array<Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    let rawData = "";
    req.on("data", (chunk: Buffer) => {
      rawData += chunk.toString();
    });

    req.on("end", () => {
      let isStreaming = false;
      let parsedBody: Record<string, unknown> = {};

      try {
        parsedBody = JSON.parse(rawData);
        isStreaming = Boolean(parsedBody.stream);
        receivedBodies.push(parsedBody);
      } catch {}

      const messages = Array.isArray(parsedBody.messages)
        ? (parsedBody.messages as Array<Record<string, unknown>>)
        : [];

      const fullPromptText = JSON.stringify(messages);
      const hasActiveRulesBlock = fullPromptText.includes("<active_path_rules>");

      const responseContent = hasActiveRulesBlock
        ? `OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_INJECTED: ${messages.length} messages received`
        : `OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_EVICTED: ${messages.length} messages received`;

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        // Chunk 1: Role delta
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "gpt-5.6-luna",
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );

        // Chunk 2: Content delta
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "gpt-5.6-luna",
            choices: [
              {
                index: 0,
                delta: { content: responseContent },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );

        // Chunk 3: Stop
        res.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "gpt-5.6-luna",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          })}\n\n`
        );

        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "gpt-5.6-luna",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: responseContent,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          })
        );
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
    resolve({
      server,
      actualPort,
      receivedBodies,
      getLastReceivedMessages() {
        if (receivedBodies.length === 0) return [];
        const last = receivedBodies[receivedBodies.length - 1];
        return (last?.messages as Array<Record<string, unknown>>) || [];
      },
      clearHistory() {
        receivedBodies.length = 0;
      },
      close: () =>
        new Promise<void>((resClose) => {
          server.close(() => resClose());
        }),
    });
  });

  return promise;
}

if (import.meta.main || process.argv[1]?.endsWith("mock-llm-server.ts")) {
  startMockOpenAiServer(19988).then(() => {
    console.log("Mock OpenAI Server listening on http://127.0.0.1:19988");
  });
}
