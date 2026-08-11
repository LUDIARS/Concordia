self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // A malformed payload must not abort the browser's required visible notification.
  }
  event.waitUntil(showNotificationUnlessSessionIsVisible(data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const path = typeof sessionId === "string" && sessionId ? sessionPath(sessionId) : "/sessions";
  event.waitUntil(openOrFocus(path));
});

async function showNotificationUnlessSessionIsVisible(data) {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const path = sessionId ? sessionPath(sessionId) : null;
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  if (path && windows.some((client) => {
    const visiblePath = new URL(client.url).pathname;
    return client.visibilityState === "visible" && (visiblePath === path || visiblePath === `${path}/logs`);
  })) {
    return;
  }
  await self.registration.showNotification(
    typeof data.title === "string" && data.title ? data.title : "Concordia",
    {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: true,
      data: { sessionId },
    },
  );
}

async function openOrFocus(path) {
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => new URL(client.url).pathname === path);
  if (existing) {
    await existing.focus();
    return;
  }
  await clients.openWindow(path);
}

function sessionPath(sessionId) {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}
