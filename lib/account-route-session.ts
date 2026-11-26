import { getSessionUser } from "./auth-server";
import { accountFailure } from "./account-server";

export async function readRouteSession() {
  try {
    return { user: await getSessionUser() } as const;
  } catch (error) {
    return { response: accountFailure(error) } as const;
  }
}
