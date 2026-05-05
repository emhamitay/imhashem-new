"use server";

/*
A small Server Function used by the integration tests and the home page.
Lives at the top of `app/` rather than inside a route folder because module-
level "use server" files are conventionally shared across pages.
*/

let counter = 0;
let lastSubmittedMessage = "";

export async function bump(by: number): Promise<number> {
  counter += by;
  return counter;
}

export async function getCounter(): Promise<number> {
  return counter;
}

export async function echo(message: string): Promise<{ message: string; at: number }> {
  return { message, at: Date.now() };
}

/*
No-JS form-submit target. Takes the FormData directly because that's what the
$ACTION_ID_* dispatch path passes in (rsdw's decodeAction binds formData as the
first arg). Stores the value so a follow-up JS-path call can observe the
side effect — a return value alone wouldn't be visible to the test, since the
no-JS response is plain HTML and our pages don't render lastSubmittedMessage.
*/
export async function submitMessage(formData: FormData): Promise<string> {
  const msg = String(formData.get("message") ?? "");
  lastSubmittedMessage = msg;
  return msg;
}

export async function getLastMessage(): Promise<string> {
  return lastSubmittedMessage;
}
