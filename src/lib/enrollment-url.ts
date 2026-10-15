export function buildEnrollmentUrl(url: string, enrollmentToken: string): string {
  const u = new URL(url);
  u.hash = `enroll=${encodeURIComponent(enrollmentToken)}`;
  return u.toString();
}
