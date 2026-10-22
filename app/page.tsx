/**
 * The page decides who may see it, on the server.
 *
 * Not in the client, and not by asking the API after the bundle has loaded: a gate that lives in
 * client JavaScript is only as fresh as the bundle the device is holding. The form has to be in the
 * HTML, and the app must not be in the HTML at all when there is no session.
 */
import { cookies } from "next/headers";

import AuthGate from "@/components/AuthGate";
import FlowwingApp from "@/components/FlowwingApp";
import { SESSION_COOKIE, sessionUser } from "@/src/lib/learner/auth";

// Rendered per request: the answer depends on a cookie, and a cached answer is the bug this page
// was written to fix.
export const dynamic = "force-dynamic";

export default async function Page() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = sessionUser(token);

  if (!session) return <AuthGate />;
  return <FlowwingApp initialUsername={session.username} />;
}
