"use server";

/*
A small Server Function used by the integration tests and the home page.
Lives at the top of `app/` rather than inside a route folder because module-
level "use server" files are conventionally shared across pages.
*/

let counter = 0;

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
