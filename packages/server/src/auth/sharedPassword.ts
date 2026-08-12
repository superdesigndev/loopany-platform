import { timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

import * as store from "../db/store.js";

const body = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(512),
});

function sameSecret(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Internal dogfood login. The shared secret admits an allowlisted email, then
 * Better Auth owns the durable session and secure cookie as usual. */
export function sharedPasswordPlugin(options: {
  secret: string;
  teamId: string;
  emailAllowed(email: string): boolean;
}): BetterAuthPlugin {
  return {
    id: "loopany-shared-password",
    endpoints: {
      kernelSharedLogin: createAuthEndpoint(
        "/kernel-shared-login",
        { method: "POST", body, requireHeaders: true },
        async (ctx) => {
          const email = ctx.body.email.trim().toLowerCase();
          if (!options.emailAllowed(email) || !sameSecret(ctx.body.password, options.secret)) {
            throw new APIError("UNAUTHORIZED", { message: "Invalid email or password" });
          }

          let user = (await ctx.context.internalAdapter.findUserByEmail(email))?.user;
          if (!user) {
            user = await ctx.context.internalAdapter.createUser({
              email,
              emailVerified: true,
              name: email.split("@")[0] || email,
            });
          }
          if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Unable to create user" });

          await store.ensureTeam(options.teamId, "Loopany Kernel", null);
          await store.addTeamMember(options.teamId, user.id, "member");
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Unable to create session" });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true, user: { id: user.id, email } });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path) => path === "/kernel-shared-login", window: 60, max: 8 }],
  };
}
