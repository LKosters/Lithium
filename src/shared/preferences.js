const preferenceKey = key => ['sidebarView', 'playerMode', 'browserUrl'].includes(key) || /^lithium-chat-draft-[a-zA-Z0-9_-]{1,255}$/.test(key);
function validPreference(key, value) {
  return preferenceKey(key) && (value === null || (typeof value === 'string' && value.length <= 200000 &&
    (key !== 'sidebarView' || ['default', 'compact'].includes(value)) &&
    (key !== 'playerMode' || ['full', 'compact', 'none'].includes(value)) &&
    (key !== 'browserUrl' || /^https?:\/\//i.test(value))));
}
module.exports = { preferenceKey, validPreference };
