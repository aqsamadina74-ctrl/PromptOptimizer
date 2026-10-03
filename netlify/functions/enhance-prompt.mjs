const MODEL = "gemini-flash-lite-latest";
export default async (req) => {
  if (req.method !== "POST") {
    return Response.json(
      { code: "method_not_allowed" },
      { status: 405 }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { code: "api_key_missing" },
      { status: 500 }
    );
  }

  try {
    const body = await req.json();

    const input =
      typeof body?.input === "string"
        ? body.input.trim()
        : "";

    if (!input) {
      return Response.json(
        { code: "invalid_request" },
        { status: 400 }
      );
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let geminiRes = null;
    let lastError = null;

    // Try Gemini up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();

      // Stop waiting after 8 seconds
      const timeout = setTimeout(() => {
        controller.abort();
      }, 8000);

      try {
        geminiRes = await fetch(url, {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: `You are a prompt optimization assistant.

Return ONLY valid JSON with exactly these four fields:

{
  "enhanced": "the improved prompt",
  "changes": ["change 1", "change 2"],
  "placeholders": ["placeholder 1"],
  "question": "one useful clarification question, or an empty string"
}

Improve the user's prompt while preserving its original intent.`
                }
              ]
            },

            contents: [
              {
                parts: [
                  {
                    text: input
                  }
                ]
              }
            ],

            generationConfig: {
              responseMimeType: "application/json"
            }
          }),

          signal: controller.signal
        });

        clearTimeout(timeout);

        // Retry temporary Gemini errors
        if (
          geminiRes.status !== 503 &&
          geminiRes.status !== 429
        ) {
          break;
        }

        lastError =
          `Gemini returned HTTP ${geminiRes.status}`;

      } catch (error) {
        clearTimeout(timeout);

        lastError =
          error?.name === "AbortError"
            ? "Gemini request timed out"
            : error?.message || "Gemini request failed";

        console.error(
          `Gemini attempt ${attempt + 1} failed:`,
          lastError
        );
      }

      // Wait before retrying
      if (attempt < 2) {
        const delay = 1000 * Math.pow(2, attempt);

        await new Promise((resolve) =>
          setTimeout(resolve, delay)
        );
      }
    }

    // Gemini did not respond
    if (!geminiRes) {
      console.error(
        "Gemini unavailable after retries:",
        lastError
      );

      return Response.json(
        {
          code: "gemini_unavailable",
          details:
            lastError ||
            "Gemini did not respond."
        },
        { status: 502 }
      );
    }

    // Read Gemini response
    let data;

    try {
      data = await geminiRes.json();
    } catch (error) {
      console.error(
        "Could not read Gemini response:",
        error?.message || error
      );

      return Response.json(
        {
          code: "invalid_gemini_response"
        },
        { status: 502 }
      );
    }

    // Gemini returned an HTTP error
    if (!geminiRes.ok) {
      const status = geminiRes.status;

      console.error(
        "Gemini API error:",
        status,
        JSON.stringify(data)
      );

      return Response.json(
        {
          code:
            status === 429
              ? "rate_limited"
              : status === 503
              ? "gemini_unavailable"
              : "api_error",

          details:
            data?.error?.message ||
            "Unknown Gemini API error"
        },
        { status: 502 }
      );
    }

    // Extract Gemini text
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      console.error(
        "Gemini returned no usable text:",
        JSON.stringify(data)
      );

      return Response.json(
        {
          code: "empty_gemini_response"
        },
        { status: 502 }
      );
    }

    // Parse Gemini JSON
    let result;

    try {
      result = JSON.parse(text);
    } catch {
      try {
        const cleaned = text
          .replace(/^```json\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        result = JSON.parse(cleaned);
      } catch {
        console.error(
          "Gemini returned invalid JSON:",
          text
        );

        return Response.json(
          {
            code: "invalid_gemini_json"
          },
          { status: 502 }
        );
      }
    }

    // Return clean response to website
    return Response.json({
      enhanced:
        typeof result.enhanced === "string"
          ? result.enhanced
          : "",

      changes:
        Array.isArray(result.changes)
          ? result.changes
          : [],

      placeholders:
        Array.isArray(result.placeholders)
          ? result.placeholders
          : [],

      question:
        typeof result.question === "string"
          ? result.question
          : ""
    });

  } catch (error) {
    console.error(
      "enhance-prompt error:",
      error?.message || error
    );

    return Response.json(
      {
        code: "api_error",
        details:
          error?.message ||
          "Unexpected server error"
      },
      { status: 500 }
    );
  }
};