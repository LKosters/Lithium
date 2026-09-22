let owner = null;
function acquire(name) {
  if (owner) throw new Error(`Lithium is already busy with ${owner}. Please wait.`);
  owner = name;
  return () => { if (owner === name) owner = null; };
}
module.exports = { acquire, isBusy: () => owner !== null };
