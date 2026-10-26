/** Provider route exposed to customer subaccounts. */
export const CUSTOMER_MODEL_PROVIDER = 'codex';

/**
 * Whether a model route is available to a customer subaccount.
 * @param provider - provider route from the catalog or model request.
 * @param model - model id; Codex requires a GPT version of at least 5.6.
 * @param allowedModels - optional account allowlist; an empty list denies every route.
 * @returns whether the route meets the customer model policy.
 */
export function customerModelAllowed(provider: string, model: string, allowedModels: readonly string[] | null = null): boolean {
  if (allowedModels !== null && !allowedModels.includes(`${provider}/${model}`)) return false;
  if (provider !== CUSTOMER_MODEL_PROVIDER && provider !== 'subscriptions-codex') return true;
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/.exec(model);
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? '0');
  return major > 5 || (major === 5 && minor >= 6);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Filter the sidebar's session-scoped Git model metadata using the account grants.
 * Upstream failures remain failures; malformed successes never expose a raw catalog.
 * @param method - sidebar metadata method; neither method invokes a model.
 * @param response - JSON response from the sidebar Host.
 * @param allowedModels - account model allowlist, or null for unrestricted routes.
 * @returns filtered response, or null when the success payload is invalid.
 */
export function filterCustomerGitModelResponse(
  method: 'git.models' | 'git.commit-model',
  response: unknown,
  allowedModels: readonly string[] | null,
): unknown | null {
  const envelope = recordOf(response);
  if (envelope?.ok === false) return response;
  if (envelope?.ok !== true) return null;
  const value = recordOf(envelope.value);
  if (value === null) return null;
  const routeAllowed = (candidate: unknown): boolean => {
    const route = recordOf(candidate);
    return route !== null && typeof route.provider === 'string' && typeof route.model === 'string' &&
      customerModelAllowed(route.provider, route.model, allowedModels);
  };
  if (method === 'git.commit-model') {
    if (typeof value.pinned !== 'boolean') return null;
    const allowed = routeAllowed(value.route);
    return { ok: true, value: { ...(allowed ? { route: value.route } : {}), pinned: allowed && value.pinned } };
  }
  if (typeof value.llm !== 'boolean' || !Array.isArray(value.providers) || !Array.isArray(value.recent)) return null;
  const providers = value.providers.flatMap(candidate => {
    const provider = recordOf(candidate);
    if (provider === null || typeof provider.provider !== 'string' || !Array.isArray(provider.models)) return [];
    const models = provider.models.filter(candidateModel => {
      const model = recordOf(candidateModel);
      return model !== null && typeof model.id === 'string' &&
        customerModelAllowed(String(provider.provider), model.id, allowedModels);
    });
    return models.length === 0 ? [] : [{ ...provider, models }];
  });
  return { ok: true, value: {
    llm: value.llm, providers, recent: value.recent.filter(routeAllowed),
    ...(routeAllowed(value.default) ? { default: value.default } : {}),
  } };
}

/**
 * Filter a successful llm.models or session.models response for a customer.
 * Upstream error responses remain unchanged; malformed success responses fail
 * closed so the gateway never returns an unfiltered catalog.
 */
export function filterCustomerModelCatalogResponse(response: unknown, allowedModels: readonly string[] | null = null): unknown | null {
  const envelope = recordOf(response);
  const result = recordOf(envelope?.result);
  if (envelope === null || result === null) return null;
  if (result.ok === false) return response;
  if (result.ok !== true) return null;

  const value = recordOf(result.value);
  if (value === null || !Array.isArray(value.groups) || !Array.isArray(value.failures)) return null;

  const groups = value.groups.flatMap((candidate) => {
    const group = recordOf(candidate);
    if (group === null || !Array.isArray(group.models)) return [];
    if (typeof group.id !== 'string') return [];
    const models = group.models.filter((candidateModel) => {
      const model = recordOf(candidateModel);
      return model !== null && typeof model.id === 'string' && customerModelAllowed(String(group.id), model.id) &&
        (allowedModels === null || allowedModels.includes(`${String(group.id)}/${model.id}`));
    });
    return models.length === 0 ? [] : [{ ...group, models }];
  });
  const defaultSelection = recordOf(value.default);
  const defaultAllowed = defaultSelection !== null && typeof defaultSelection.provider === 'string' && typeof defaultSelection.model === 'string' && customerModelAllowed(defaultSelection.provider, defaultSelection.model, allowedModels);
  return {
    ...envelope,
    result: {
      ...result,
      value: {
        ...value,
        groups,
        failures: allowedModels === null ? value.failures : value.failures.filter(candidate => { const row = recordOf(candidate); return row !== null && typeof row.id === 'string' && allowedModels.some(id => id.startsWith(`${row.id}/`)); }),
        ...(Object.hasOwn(value, 'default') ? { default: defaultAllowed ? value.default : null } : {}),
        ...(Array.isArray(value.routableProviders) ? { routableProviders: value.routableProviders.filter(id => typeof id === 'string' && (allowedModels === null || allowedModels.some(model => model.startsWith(`${id}/`)))) } : {}),
      },
    },
  };
}
