// Read-only access to MongoDB. $out and $merge are the only aggregation stages
// that write, so any pipeline containing one (also inside $lookup/$facet) is
// refused before it reaches the database.
function assertReadOnly(pipeline) {
  const writeStage = JSON.stringify(pipeline).match(/"\$(out|merge)"\s*:/);
  if (writeStage) {
    throw new Error(`Refusing to run a pipeline with $${writeStage[1]}: this tool only reads`);
  }
}

function aggregate(collection, pipeline) {
  assertReadOnly(pipeline);
  return collection.aggregate(pipeline, { allowDiskUse: true });
}

module.exports = { aggregate, assertReadOnly };
