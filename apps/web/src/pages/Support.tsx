import { useState, type FormEvent } from "react";
import { ApiError, post, type ChatResponse } from "../api";
import { Field } from "../components/Field";
import { useFocusFirstInvalid } from "../focus";

const MAX_LENGTH = 1000;

export function SupportPage() {
  const [question, setQuestion] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [response, setResponse] = useState<ChatResponse>();
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const empty = !question.trim();
    setInvalid(empty);
    if (empty) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setResponse(await post<ChatResponse>("/support/chat", { question }));
    } catch (cause) {
      setResponse(undefined);
      setError(cause instanceof ApiError ? cause.message : "Could not reach the assistant. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Support</h1>
          <p className="muted">Answers come only from approved support articles and orders on your account. Check the sources shown.</p>
        </div>
      </header>
      <section className="panel" aria-labelledby="ask-heading">
        <h2 id="ask-heading">Ask a question</h2>
        <form ref={formRef} className="support-form" onSubmit={submit} noValidate>
          <Field label="Your question" error={invalid ? "Enter a question" : undefined} hint={`Up to ${MAX_LENGTH} characters.`}>
            <textarea value={question} maxLength={MAX_LENGTH} onChange={(event) => setQuestion(event.target.value)} data-testid="support-question" />
          </Field>
          <button type="submit" className="button button-primary" aria-disabled={busy} data-testid="support-submit">
            {busy ? "Asking…" : "Ask"}
          </button>
        </form>
        <div className="support-result" aria-live="polite" data-testid="support-result">
          {error && (
            <div className="alert alert-error" role="alert" data-testid="support-error">
              {error}
            </div>
          )}
          {response?.status === "answered" && (
            <div data-testid="support-answer">
              <h3>Answer</h3>
              <p>{response.answer}</p>
              <h3>Sources</h3>
              <ol className="support-sources" data-testid="support-sources">
                {response.citations.map((citation) => (
                  <li key={`${citation.source_id}-${citation.quote}`}>
                    <strong>{citation.source_id}</strong>
                    <blockquote>{citation.quote}</blockquote>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {response && response.status !== "answered" && (
            <div className="alert alert-warning" data-testid="support-refusal">
              {response.message}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
