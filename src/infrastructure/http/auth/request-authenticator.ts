/**
 * Ponto de extensão de autenticação (seção 3, decisão B).
 * Para ligar um IdP, troque o provider de REQUEST_AUTHENTICATOR por uma implementação
 * que valide o token (ex.: JWT assinado pelo Keycloak/Zitadel, verificado via JWKS).
 */
export interface RequestAuthenticator {
  /** true se a requisição é autêntica. */
  authenticate(request: { headers: Record<string, string | string[] | undefined> }): Promise<boolean> | boolean;
}

export const REQUEST_AUTHENTICATOR = Symbol('REQUEST_AUTHENTICATOR');

/** Decisão B: sem autenticação — aceita toda requisição. */
export class NoopRequestAuthenticator implements RequestAuthenticator {
  authenticate(): boolean {
    return true;
  }
}
