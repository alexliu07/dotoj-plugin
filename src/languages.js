'use strict';

// Languages are listed in server order; pin the last used one to the top so
// repeated submissions need only one Enter.
function orderLanguages(languages, lastId) {
  const list = Array.isArray(languages) ? languages.slice() : [];
  if (!lastId) {
    return list;
  }
  const index = list.findIndex((item) => item && item.id === lastId);
  if (index <= 0) {
    return list;
  }
  const recent = list[index];
  list.splice(index, 1);
  list.unshift(recent);
  return list;
}

module.exports = { orderLanguages };