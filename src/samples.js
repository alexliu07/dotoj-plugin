'use strict';

const { decodeBase64 } = require('./markdown');

const cache = new Map();

function hasLegacySamples(problem) {
  return Array.isArray(problem.sampleCases) && problem.sampleCases.length > 0;
}

function legacySamples(problem) {
  return problem.sampleCases.map((item) => ({
    input: decodeBase64(item.input),
    output: decodeBase64(item.output),
  }));
}

async function fetchPublicCases(client, problem) {
  const set = problem.publicTestSet;
  const total = Number(set.caseCount) || 0;
  const samples = [];
  for (let number = 1; number <= total; number += 1) {
    const data = await client.getPublicCase(problem.id, number, set.revision);
    samples.push({
      input: data && data.input ? String(data.input.content || '') : '',
      output: data && data.output ? String(data.output.content || '') : '',
    });
  }
  return samples;
}

// dotOJ <= 2.5 embeds base64 samples in the problem payload; 2.7+ replaced
// them with a public test set that has to be fetched case by case.
async function loadSamples(client, problem) {
  if (!problem) {
    return [];
  }
  if (hasLegacySamples(problem)) {
    return legacySamples(problem);
  }
  const set = problem.publicTestSet;
  if (!set || !set.caseCount) {
    return [];
  }
  const server = client && typeof client.baseUrl === 'function' ? client.baseUrl() : '';
  const key = server + '|' + problem.id + ':' + set.revision + ':' + set.caseCount;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const samples = await fetchPublicCases(client, problem);
  cache.set(key, samples);
  return samples;
}

function clearSampleCache() {
  cache.clear();
}

module.exports = { loadSamples, clearSampleCache };