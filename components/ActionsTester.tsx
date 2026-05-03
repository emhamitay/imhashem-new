"use client";

import { useMemo, useState } from "react";
import { bump, echo, getCounter } from "../app/actions.ts";
import { useParams } from "../framework/hooks.ts";

type TesterProps = {
  expectedName: string;
};

export function ActionsTester({ expectedName }: TesterProps) {
  const params = useParams();
  const [counterValue, setCounterValue] = useState<number | null>(null);
  const [counterReadAt, setCounterReadAt] = useState<number | null>(null);
  const [echoValue, setEchoValue] = useState<string>("");
  const [status, setStatus] = useState<string>("idle");
  const [error, setError] = useState<string>("");

  const routeName = useMemo(() => params.name ?? "(missing)", [params.name]);
  const paramsMatch = routeName === expectedName;

  async function runGetCounter() {
    setStatus("calling getCounter()");
    setError("");
    try {
      const value = await getCounter();
      setCounterValue(value as number);
      setCounterReadAt(Date.now());
      setStatus("getCounter() ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("getCounter() failed");
    }
  }

  async function runBump() {
    setStatus("calling bump(1)");
    setError("");
    try {
      const value = await bump(1);
      setCounterValue(value as number);
      setCounterReadAt(Date.now());
      setStatus("bump(1) ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("bump(1) failed");
    }
  }

  async function runEcho() {
    setStatus("calling echo(...)");
    setError("");
    try {
      const response = await echo(`hello from ${routeName}`);
      setEchoValue(`${response.message} @ ${new Date(response.at).toISOString()}`);
      setStatus("echo(...) ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("echo(...) failed");
    }
  }

  return (
    <section>
      <h2>Actions + useParams Test</h2>
      <p>Expected param from server prop: {expectedName}</p>
      <p>Client `useParams().name`: {routeName}</p>
      <p>Match: {paramsMatch ? "yes" : "no"}</p>

      <div>
        <button onClick={runGetCounter}>Test getCounter()</button>
        <button onClick={runBump}>Test bump(1)</button>
        <button onClick={runEcho}>Test echo(...)</button>
      </div>

      <p>Status: {status}</p>
      <p>Counter value: {counterValue ?? "(not loaded yet)"}</p>
      <p>Counter last sync: {counterReadAt ? new Date(counterReadAt).toISOString() : "(never)"}</p>
      <p>Echo value: {echoValue || "(none yet)"}</p>
      {error ? <pre>{error}</pre> : null}
    </section>
  );
}
