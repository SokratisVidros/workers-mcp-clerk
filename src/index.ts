import { WorkerEntrypoint } from 'cloudflare:workers';
import { ProxyToSelf } from 'workers-mcp';
import { createClerkClient, type User } from "@clerk/backend";

const BASIC_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Env {
  CLERK_SECRET_KEY: string;
} 

export default class MyWorker extends WorkerEntrypoint<Env> {
  /**
   * A warm, friendly greeting from your new MCP server.
   * @param emailOrUserId {string} The email or userId of the person to greet.
   * @return {string} The greeting message.
   */
  async sayHello(email: string) {
    const jwt = await this.impersonate(email);

    // Use this JWT to make API calls to a Clerk protected API route.
    // For Demo purposes, we'll just log the JWT in the greeting message.
    return `Hello from an MCP Worker, ${email}! Your JWT is ${jwt}`;
  }

  /**
   * @ignore
   */
  async fetch(request: Request): Promise<Response> {
    // ProxyToSelf handles MCP protocol compliance.
    return new ProxyToSelf(this).fetch(request);
  }

  /**
   * @ignore
   */
  private async impersonate(emailOrUserId: string) {
    const user = await this.getUser(emailOrUserId);
  
    if (!user) {
      throw new Error(`User ${emailOrUserId} not found`);
    }

    // TODO: Open a PR to add this to @clerk/backend
    const actorTokenResponse = await fetch('https://api.clerk.com/v1/actor_tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getClerkSecretKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: user.id,
        expires_in_seconds: 600,
        actor: {
          sub: 'foo',
        },
      }),
    });
  
    if (!actorTokenResponse.ok) {
      throw new Error(`Failed to create actor token: ${actorTokenResponse.statusText}`);
    }
  
    const { token: ticket, url } = (await actorTokenResponse.json()) as { token: string; url: string };
  
    const clerkFrontendAPI = new URL(url).origin;
  
    // TODO: Open a PR to add this to @clerk/backend
    const signInResponse = await fetch(`${clerkFrontendAPI}/v1/client/sign_ins?__clerk_api_version=2024-10-01`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        strategy: 'ticket',
        ticket,
      }).toString(),
    });
  
    if (!signInResponse.ok) {
      throw new Error(`Failed to sign in: ${signInResponse.statusText}`);
    }
  
    const { client } = (await signInResponse.json()) as {
      client: { last_active_session_id: string; sessions: { id: string; last_active_token: { jwt: string } }[] };
    };
  
    const jwt = client.sessions.find((s) => s.id === client.last_active_session_id)?.last_active_token.jwt;
  
    if (!jwt) {
      throw new Error('Failed to get JWT');
    }
  
    return jwt;
  }

  /**
   * @ignore
   */
  private async getUser(emailOrUserId: string): Promise<User> {
    console.log("Getting user: ", emailOrUserId, this.getClerkSecretKey());
    const clerk = createClerkClient({
      secretKey: this.getClerkSecretKey()
    });
    
    try {
      if ((emailOrUserId || '').startsWith('user_')) {
        return await clerk.users.getUser(emailOrUserId);
      }

      if (BASIC_EMAIL_REGEX.test(emailOrUserId || '')) {
        const users = await clerk.users.getUserList({
          emailAddress: [emailOrUserId],
          orderBy: '-last_sign_in_at',
        });
      
        return users.data[0];
      }
    } catch (error) {
      console.error("Error getting user: ", error);
    }

    throw new Error(`Invalid user ID or email: ${emailOrUserId}. Please provider a user ID or email address.`);
  }
  
  /**
   * @ignore
   */
  private getClerkSecretKey(): string {
    if (!this.env.CLERK_SECRET_KEY) {
      throw new Error('CLERK_SECRET_KEY is not set');
    }
    return this.env.CLERK_SECRET_KEY;
  }
 
}