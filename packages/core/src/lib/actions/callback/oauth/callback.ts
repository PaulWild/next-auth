import * as checks from "./checks.js"
import * as o from "oauth4webapi"
import {
  OAuthCallbackError,
  OAuthProfileParseError,
} from "../../../../errors.js"

import type {
  InternalOptions,
  InternalProvider,
  LoggerInstance,
  Profile,
  RequestInternal,
  TokenSet,
  User,
} from "../../../../types.js"
import type { OAuthConfigInternal } from "../../../../providers/index.js"
import type { Cookie } from "../../../utils/cookie.js"

/**
 * Handles the following OAuth steps.
 * https://www.rfc-editor.org/rfc/rfc6749#section-4.1.1
 * https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3
 * https://openid.net/specs/openid-connect-core-1_0.html#UserInfoRequest
 *
 * @note Although requesting userinfo is not required by the OAuth2.0 spec,
 * we fetch it anyway. This is because we always want a user profile.
 */
export async function handleOAuth(
  query: RequestInternal["query"],
  cookies: RequestInternal["cookies"],
  options: InternalOptions<"oauth" | "oidc">,
  randomState?: string
) {
  const { logger, provider } = options
  let as: o.AuthorizationServer

  const { token, userinfo } = provider
  // Falls back to authjs.dev if the user only passed params
  if (
    (!token?.url || token.url.host === "authjs.dev") &&
    (!userinfo?.url || userinfo.url.host === "authjs.dev")
  ) {
    // We assume that issuer is always defined as this has been asserted earlier
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const issuer = new URL(provider.issuer!)
    const discoveryResponse = await o.discoveryRequest(issuer)
    const discoveredAs = await o.processDiscoveryResponse(
      issuer,
      discoveryResponse
    )

    if (!discoveredAs.token_endpoint)
      throw new TypeError(
        "TODO: Authorization server did not provide a token endpoint."
      )

    if (!discoveredAs.userinfo_endpoint)
      throw new TypeError(
        "TODO: Authorization server did not provide a userinfo endpoint."
      )

    as = discoveredAs
  } else {
    as = {
      issuer: provider.issuer ?? "https://authjs.dev", // TODO: review fallback issuer
      token_endpoint: token?.url.toString(),
      userinfo_endpoint: userinfo?.url.toString(),
    }
  }

  const client: o.Client = {
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    ...provider.client,
  }

  const resCookies: Cookie[] = []

  const state = await checks.state.use(
    cookies,
    resCookies,
    options,
    randomState
  )

  const codeGrantParams = o.validateAuthResponse(
    as,
    client,
    new URLSearchParams(query),
    provider.checks.includes("state") ? state : o.skipStateCheck
  )

  /** https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2.1 */
  if (o.isOAuth2Error(codeGrantParams)) {
    const cause = { providerId: provider.id, ...codeGrantParams }
    logger.debug("OAuthCallbackError", cause)
    throw new OAuthCallbackError("OAuth Provider returned an error", cause)
  }

  const codeVerifier = await checks.pkce.use(cookies, resCookies, options)

  let redirect_uri = provider.callbackUrl
  if (!options.isOnRedirectProxy && provider.redirectProxyUrl) {
    redirect_uri = provider.redirectProxyUrl
  }

  let tokens: TokenSet
  if (provider.token?.request) {
    const result = await provider.token.request({
      params: {
        state,
        redirect_uri,
        ...query,
      },
      checks,
      provider,
    })
    if (!result) {
      throw new Error("Custom token request did not return a valid tokenset")
    }
    tokens = result.tokens
  } else {
    tokens = await getTokens(
      as,
      client,
      codeGrantParams,
      redirect_uri,
      codeVerifier,
      provider,
      cookies,
      resCookies,
      options
    )
  }

  const profile =
    provider.type === "oidc"
      ? o.getValidatedIdTokenClaims(tokens)
      : await getOauthProfile(provider, as, client, tokens)

  if (tokens.expires_in) {
    tokens.expires_at =
      Math.floor(Date.now() / 1000) + Number(tokens.expires_in)
  }

  const profileResult = await getUserAndAccount(
    profile,
    provider,
    tokens,
    logger
  )

  return { ...profileResult, profile, cookies: resCookies }
}

async function getTokens(
  as: o.AuthorizationServer,
  client: o.Client,
  codeGrantParams: URLSearchParams,
  redirect_uri: string,
  codeVerifier: string | undefined,
  provider: InternalProvider<"oauth" | "oidc">,
  cookies: Partial<Record<string, string>> | undefined,
  resCookies: Cookie[],
  options: InternalOptions<"oauth" | "oidc">
) {
  let codeGrantResponse = await o.authorizationCodeGrantRequest(
    as,
    client,
    codeGrantParams,
    redirect_uri,
    codeVerifier ?? "auth", // TODO: review fallback code verifier,
    {
      [o.customFetch]: (...args) => {
        if (
          !provider.checks.includes("pkce") &&
          args[1]?.body instanceof URLSearchParams
        ) {
          args[1].body.delete("code_verifier")
        }
        return fetch(...args)
      },
    }
  )

  if (provider.token?.conform) {
    codeGrantResponse =
      (await provider.token.conform(codeGrantResponse.clone())) ??
      codeGrantResponse
  }

  let challenges: o.WWWAuthenticateChallenge[] | undefined
  if ((challenges = o.parseWwwAuthenticateChallenges(codeGrantResponse))) {
    for (const challenge of challenges) {
      console.log("challenge", challenge)
    }
    throw new Error("TODO: Handle www-authenticate challenges as needed")
  }

  if (provider.type === "oidc") {
    const nonce = await checks.nonce.use(cookies, resCookies, options)
    const result = await o.processAuthorizationCodeOpenIDResponse(
      as,
      client,
      codeGrantResponse,
      nonce ?? o.expectNoNonce
    )

    if (o.isOAuth2Error(result)) {
      console.log("error", result)
      throw new Error("TODO: Handle OIDC response body error")
    }
    return result
  } else {
    const result = await o.processAuthorizationCodeOAuth2Response(
      as,
      client,
      codeGrantResponse
    )
    if (o.isOAuth2Error(result)) {
      console.log("error", result)
      throw new Error("TODO: Handle OAuth 2.0 response body error")
    }
    return result
  }
}

async function getOauthProfile(
  provider: InternalProvider<"oauth">,
  as: o.AuthorizationServer,
  client: o.Client,
  tokens: TokenSet
) {
  if (provider.userinfo?.request) {
    const result = await provider.userinfo.request({ tokens, provider })
    return result instanceof Object ? result : {}
  } else if (provider.userinfo?.url) {
    const userinfoResponse = await o.userInfoRequest(
      as,
      client,
      (tokens as any).access_token
    )
    return await userinfoResponse.json()
  }

  throw new TypeError("No userinfo endpoint configured")
}

/**
 * Returns the user and account that is going to be created in the database.
 * @internal
 */
export async function getUserAndAccount(
  OAuthProfile: Profile,
  provider: OAuthConfigInternal<any>,
  tokens: TokenSet,
  logger: LoggerInstance
) {
  try {
    const userFromProfile = await provider.profile(OAuthProfile, tokens)
    const user = {
      ...userFromProfile,
      id: crypto.randomUUID(),
      email: userFromProfile.email?.toLowerCase(),
    } satisfies User

    return {
      user,
      account: {
        ...tokens,
        provider: provider.id,
        type: provider.type,
        providerAccountId: userFromProfile.id ?? crypto.randomUUID(),
      },
    }
  } catch (e) {
    // If we didn't get a response either there was a problem with the provider
    // response *or* the user cancelled the action with the provider.
    //
    // Unfortunately, we can't tell which - at least not in a way that works for
    // all providers, so we return an empty object; the user should then be
    // redirected back to the sign up page. We log the error to help developers
    // who might be trying to debug this when configuring a new provider.
    logger.debug("getProfile error details", OAuthProfile)
    logger.error(
      new OAuthProfileParseError(e as Error, { provider: provider.id })
    )
  }
}
