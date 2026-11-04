import { expect, test } from "../../framework/fixtures/api";
import { expectApiError } from "../../framework/helpers/api-client";

interface Chat {
  status: string;
  answer: string | null;
  message: string | null;
  refusal_reason: string | null;
  citations: { source_id: string; quote: string }[];
  evidence: { source_id: string; text: string; kind: string }[];
  mode: string;
}

test.describe("POST /support/chat", { tag: "@api" }, () => {
  test("answers from the knowledge base, with evidence kept apart from the answer", async ({ asViewer }) => {
    const response = await asViewer.api.send("POST", "/support/chat", { data: { question: "How long do refunds take?" } });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as Chat;
    expect(body.status).toBe("answered");
    expect(body.mode).toBe("offline-extractive");
    expect(body.answer).toContain("5 business days");
    expect(body.citations[0]?.source_id).toBe("REF-001");
    const cited = body.evidence.find((item) => item.source_id === "REF-001");
    expect(cited?.text).toContain(body.citations[0]?.quote);
  });

  test("the same question gets the same answer", async ({ asViewer }) => {
    const ask = async () => {
      const response = await asViewer.api.send("POST", "/support/chat", { data: { question: "Do you accept backorders?" } });
      const { answer, citations, status } = (await response.json()) as Chat;
      return { answer, citations, status };
    };
    expect(await ask()).toEqual(await ask());
  });

  test("refuses with a reason and no answer when there is no evidence", async ({ asViewer }) => {
    const response = await asViewer.api.send("POST", "/support/chat", { data: { question: "Do you offer a lifetime warranty?" } });
    const body = (await response.json()) as Chat;
    expect(body.status).toBe("refused");
    expect(body.refusal_reason).toBe("no_evidence");
    expect(body.answer).toBeNull();
    expect(body.citations).toEqual([]);
  });

  test("requires a session", async ({ anonymous }) => {
    await expectApiError(await anonymous.send("POST", "/support/chat", { data: { question: "Hello?" } }), 401, "NOT_AUTHENTICATED");
  });

  test("rejects a question that is too long, empty, the wrong type or missing", async ({ asViewer }) => {
    for (const data of [{ question: "x".repeat(1001) }, { question: "" }, { question: 42 }, {}]) {
      await expectApiError(await asViewer.api.send("POST", "/support/chat", { data }), 422, "VALIDATION_ERROR");
    }
  });

  test("accepts a question at the length limit", async ({ asViewer }) => {
    const response = await asViewer.api.send("POST", "/support/chat", { data: { question: "x".repeat(1000) } });
    expect(response.status()).toBe(200);
    expect(((await response.json()) as Chat).status).toBe("refused");
  });

  test("rejects unknown fields, so a caller cannot choose the evidence or the role", async ({ asViewer }) => {
    for (const extra of [{ evidence: [] }, { role: "system" }, { citations: [] }]) {
      await expectApiError(await asViewer.api.send("POST", "/support/chat", { data: { question: "Hello?", ...extra } }), 422, "VALIDATION_ERROR");
    }
  });
});
