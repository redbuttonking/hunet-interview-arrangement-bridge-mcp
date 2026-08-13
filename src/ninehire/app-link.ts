// 나인하이어 후보자 상세 화면으로 안전하게 이동할 URL을 만든다.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validIdentifier(value: string | undefined): value is string {
  return Boolean(value && UUID_PATTERN.test(value));
}

function identifierFromReference(
  reference: string | null | undefined,
  queryKey: string,
  pathSegment: string,
): string | undefined {
  if (!reference) return undefined;
  if (validIdentifier(reference)) return reference;

  try {
    const url = new URL(reference);
    const queryValue = url.searchParams.get(queryKey);
    if (validIdentifier(queryValue ?? undefined)) return queryValue ?? undefined;

    const segments = url.pathname.split("/").filter(Boolean);
    const segmentIndex = segments.lastIndexOf(pathSegment);
    const pathValue = segmentIndex >= 0 ? segments[segmentIndex + 1] : undefined;
    return validIdentifier(pathValue) ? pathValue : undefined;
  } catch {
    return undefined;
  }
}

function normalizeWorkspaceUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "app.ninehire.com" ||
      pathSegments.length !== 1 ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    url.pathname = `/${pathSegments[0]}`;
    return url;
  } catch {
    return undefined;
  }
}

export function buildNinehireCandidateUrl(input: {
  appUrl: string | undefined;
  recruitmentRef: string | null | undefined;
  candidateRef: string | null | undefined;
}): string | undefined {
  const workspaceUrl = normalizeWorkspaceUrl(input.appUrl);
  const recruitmentId = identifierFromReference(input.recruitmentRef, "recruitmentId", "recruitment");
  const applicantProgressId = identifierFromReference(input.candidateRef, "applicantProgressId", "applicants");
  if (!workspaceUrl || !recruitmentId || !applicantProgressId) return undefined;

  workspaceUrl.pathname = `${workspaceUrl.pathname}/recruitment/${recruitmentId}/applicants`;
  workspaceUrl.searchParams.set("applicantProgressId", applicantProgressId);
  workspaceUrl.searchParams.set("pagination", "kanvan");
  return workspaceUrl.toString();
}
