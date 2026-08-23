import * as http from "node:http";

export interface MockServerInstance {
  server: http.Server;
  receivedBodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export function startMockOpenAiServer(port = 19988): Promise<MockServerInstance> {
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
        receivedBodies.push(parsedBody);
        if (parsedBody.stream) isStreaming = true;
      } catch {}

      const messages = Array.isArray(parsedBody.messages)
        ? (parsedBody.messages as Array<Record<string, unknown>>)
        : [];

      const fullPromptText = JSON.stringify(messages);
      const hasActiveRulesBlock = fullPromptText.includes("<active_path_rules>");
      const hasInjectedApiRule = fullPromptText.includes("Always validate with Zod.");
      const touchesApiUser = fullPromptText.includes("src/api/user.ts");

      let responseContent = "";
      if (touchesApiUser) {
        if (hasActiveRulesBlock && hasInjectedApiRule) {
          responseContent = "OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_INJECTED";
        } else {
          responseContent = `ERROR_RULE_NOT_INJECTED: hasBlock=${hasActiveRulesBlock}, hasRule=${hasInjectedApiRule}, prompt=${fullPromptText.slice(0, 300)}`;
        }
      } else {
        if (!hasActiveRulesBlock && !hasInjectedApiRule) {
          responseContent = "OMP_EXTENSION_VERIFIED_SUCCESSFULLY:RULE_EVICTED";
        } else {
          responseContent = `ERROR_RULE_NOT_EVICTED: hasBlock=${hasActiveRulesBlock}`;
        }
      }

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const chunk1 = {
          id: "chatcmpl-stream-1",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: responseContent },
              finish_reason: null,
            },
          ],
        };

        const chunk2 = {
          id: "chatcmpl-stream-2",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };

        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock-test",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
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
              prompt_tokens: 20,
              completion_tokens: 10,
              total_tokens: 30,
            },
          })
        );
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    resolve({
      server,
      receivedBodies,
      close: () => {
        const { promise: closePromise, resolve: closeResolve } =
          Promise.withResolvers<void>();
        server.close(() => closeResolve());
        return closePromise;
      },
    });
  });

  return promise;
}

if (import.meta.main || process.argv[1]?.endsWith("mock-llm-server.ts")) {
  startMockOpenAiServer(19988).then(() => {
    console.log("Mock OpenAI Server listening on http://127.0.0.1:19988");
  });
}
