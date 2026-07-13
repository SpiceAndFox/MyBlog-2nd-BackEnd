const { executor } = require("./helpers");
const { normalizeIanaTimeZone } = require("../../../../utils/timeZone");

async function getTimeZone(userId, { client } = {}) {
  const { rows } = await executor(client).query("SELECT time_zone FROM users WHERE id=$1", [userId]);
  if (!rows[0]) throw new Error("Memory task user does not exist");
  return normalizeIanaTimeZone(rows[0].time_zone);
}

module.exports = { getTimeZone };
