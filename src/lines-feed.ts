import { parseErrorResponse } from "./response-parsers";
import { Repeater } from "@repeaterjs/repeater";

export default class LinesFeed {
  private decoder = new TextDecoder();
  // TODO: make this persistent
  private cache = new Map<
    string,
    { lastModified: Date; expires: Date | undefined; lines: string[] }
  >();
  private locks = new Map<string, Promise<string[]>>();

  async *parseResponse(response: Response): AsyncGenerator<string, void, void> {
    if (response.status === 204 || response.status === 304) {
      return;
    }
    if (!response.ok) {
      throw new Error((await parseErrorResponse(response)).message);
    }
    if (response.status !== 200 && response.status !== 226) {
      throw new Error(`Unexpected status code: ${response.status}`);
    }
    if (response.status === 226) {
      const im = response.headers.get("IM");
      if (!im || !im.includes("prepend")) {
        throw new Error("Unrecognized instance manipulation for delta updates");
      }
      const cacheControl = response.headers.get("Cache-Control");
      if (!cacheControl || !cacheControl.includes("im")) {
        throw new Error("Missing Cache-Control 'im' header for delta updates");
      }
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get a reader from the response body");
    }

    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();

      if (value) {
        buffer += this.decoder.decode(value);
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          yield part;
        }
      }

      if (done) break;
    }

    // Clear the buffer
    if (buffer) {
      yield buffer;
    }
  }

  async *stream(
    url: string,
    session:
      | { fetch: typeof fetch; webId: string }
      | { fetch?: undefined; webId?: undefined },
    options?: {
      ifModifiedSince?: Date;
    },
  ): AsyncGenerator<string, void, void> {
    const cacheKey = JSON.stringify({
      url,
      webId: session.webId,
    });

    // Share the results of concurrent requests
    const lock = this.locks.get(cacheKey);
    if (lock) {
      const lines = await lock;
      for (const line of lines) {
        yield line;
      }
      return;
    }

    let resolveLock: (lines: string[]) => void = () => {};
    this.locks.set(
      cacheKey,
      new Promise((resolve) => {
        resolveLock = (lines: string[]) => {
          this.locks.delete(cacheKey);
          resolve(lines);
        };
      }),
    );

    let lastModified: Date | undefined = undefined;
    let cachedLines: string[] = [];

    if (options?.ifModifiedSince) {
      lastModified = options?.ifModifiedSince;
    } else {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const expires = cached.expires;
        if (expires && new Date() > expires) {
          this.cache.delete(cacheKey);
        } else {
          lastModified = cached.lastModified;
          cachedLines = cached.lines;
        }
      }
    }

    let response: Response;
    try {
      response = await (session.fetch ?? fetch)(url, {
        headers: {
          ...(lastModified
            ? {
                "A-IM": "prepend",
                "If-Modified-Since": lastModified.toISOString(),
              }
            : {}),
        },
      });
    } catch (e) {
      resolveLock([]);
      throw e;
    }

    if (response.status === 200 || response.status === 204) {
      this.cache.delete(cacheKey);
      cachedLines = [];
    }

    const newLines: string[] = [];
    try {
      for await (const line of this.parseResponse(response)) {
        newLines.push(line);
      }
    } catch (e) {
      resolveLock([]);
      throw e;
    }

    const lines = [...newLines, ...cachedLines];

    let lastModifiedNew: Date | undefined = undefined;
    const lastModifiedString = response.headers.get("Last-Modified");
    if (lastModifiedString) {
      const lastModified = new Date(lastModifiedString);
      if (!Number.isNaN(lastModified.getTime())) {
        lastModifiedNew = lastModified;
      }
    }

    let expires: Date | undefined = undefined;
    const maxAgeString = response.headers
      .get("Cache-Control")
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => part.startsWith("max-age="))
      ?.split("=")[1];
    if (maxAgeString !== undefined) {
      const maxAgeSeconds = parseInt(maxAgeString, 10);
      if (!Number.isNaN(maxAgeSeconds) && maxAgeSeconds > 0) {
        const now = new Date();
        expires = new Date(now.getTime() + maxAgeSeconds * 1000);
      }
    }

    if (lastModifiedNew) {
      this.cache.set(cacheKey, {
        lastModified: lastModifiedNew,
        expires,
        lines,
      });
    }

    resolveLock(lines);

    for (const line of lines) {
      yield line;
    }
  }

  streamMultiple<T>(
    urlPath: string,
    parser: (line: string, pod: string) => T | Promise<T>,
    session: {
      pods: string[];
    } & (
      | {
          fetch: typeof fetch;
          webId: string;
        }
      | { fetch?: undefined; webId?: undefined }
    ),
    options?: {
      ifModifiedSince?: Date;
    },
  ): AsyncGenerator<
    | {
        error: false;
        value: T;
      }
    | {
        error: true;
        message: string;
        pod: string;
      },
    void,
    void
  > {
    const this_ = this;
    const iterators = session.pods.map((pod) => {
      // Return type is the same as the return type of the function
      return (async function* (): ReturnType<typeof this_.streamMultiple<T>> {
        let origin: string;
        try {
          origin = new URL(pod).origin;
        } catch (e) {
          yield {
            error: true,
            message: e!.toString(),
            pod,
          };
          return;
        }
        const url = `${origin}/${urlPath}`;

        try {
          for await (const line of this_.stream(url, session, options)) {
            let value: T;
            try {
              value = await parser(line, pod);
            } catch (e) {
              yield {
                error: true,
                message: e!.toString(),
                pod,
              };
              continue;
            }

            yield {
              error: false,
              value,
            };
          }
        } catch (e) {
          yield {
            error: true,
            message: e!.toString(),
            pod,
          };
        }
      })();
    });

    return Repeater.merge(iterators);
  }
}
