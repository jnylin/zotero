/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

Zotero.Duplicates = function (libraryID) {
	if (typeof libraryID == 'undefined') {
		throw ("libraryID not provided in Zotero.Duplicates constructor");
	}
	
	if (!libraryID) {
		libraryID = Zotero.Libraries.userLibraryID;
	}
	
	this._libraryID = libraryID;
}


Zotero.Duplicates.prototype.__defineGetter__('name', function () { return Zotero.getString('pane.collections.duplicate'); });
Zotero.Duplicates.prototype.__defineGetter__('libraryID', function () { return this._libraryID; });

/**
 * Get duplicates, populate a temporary table, and return a search based
 * on that table
 *
 * @return {Zotero.Search}
 */
Zotero.Duplicates.prototype.getSearchObject = async function () {
	var table = 'tmpDuplicates_' + Zotero.Utilities.randomString();
	
	await this._findDuplicates();
	var ids = this._sets.findAll(true);
	
	// Zotero.CollectionTreeRow::getSearchObject() extracts the table name and creates an
	// unload listener that drops the table when the ItemTreeView is unregistered
	var sql = `CREATE TEMPORARY TABLE ${table} (id INTEGER PRIMARY KEY)`;
	await Zotero.DB.queryAsync(sql);
	
	if (ids.length) {
		Zotero.debug("Inserting rows into temp table");
		sql = `INSERT INTO ${table} VALUES `;
		await Zotero.Utilities.Internal.forEachChunkAsync(
			ids,
			Zotero.DB.MAX_BOUND_PARAMETERS,
			async function (chunk) {
				let idStr = '(' + chunk.join('), (') + ')';
				await Zotero.DB.queryAsync(sql + idStr, false, { debug: false });
			}
		);
		Zotero.debug("Done");
	}
	else {
		Zotero.debug("No duplicates found");
	}
	
	var s = new Zotero.Search;
	s.libraryID = this._libraryID;
	s.addCondition('tempTable', 'is', table);
	return s;
};


/**
 * Finds all items in the same set as a given item
 *
 * @param {Integer} itemID
 * @return {Integer[]}  Array of itemIDs
 */
Zotero.Duplicates.prototype.getSetItemsByItemID = function (itemID) {
	return this._sets.findAllInSet(this._getObjectFromID(itemID), true);
}


Zotero.Duplicates.prototype._getObjectFromID = function (id) {
	return {
		get id() { return id; }
	}
}


Zotero.Duplicates.prototype._findDuplicates = async function () {
	Zotero.debug("Finding duplicates");
	
	var start = Date.now();
	
	var self = this;
	
	this._sets = new Zotero.DisjointSetForest;
	var sets = this._sets;
	
	function normalizeString(str) {
		// Make sure we have a string and not an integer
		str = str + "";
		
		if (str === "") {
			return "";
		}
		
		str = Zotero.Utilities.removeDiacritics(str)
			.replace(/[ !-/:-@[-`{-~]+/g, ' ') // Convert (ASCII) punctuation to spaces
			.trim()
			.toLowerCase();
		
		return str;
	}
	
	function normalizeTitle(str) {
		return normalizeString(str).replace(/^(the|a|an)\s+/, '');
	}
	
	function sortByValue(a, b) {
		if((a.value === null && b.value !== null)
			|| (a.value === undefined && b.value !== undefined)
			|| a.value < b.value) {
			return -1;
		}
		
		if(a.value === b.value) return 0;
		
		return 1;
	}
	
	/**
	 * @param {Function} compareRows  Comparison function, if not exact match
	 * @param {Boolean} reprocessMatches  Compare every row against every other,
	 *                                    without skipping ahead to the last match.
	 *                                    This is necessary for multi-dimensional
	 *                                    matches such as title + at least one creator.
	 *                                    Without it, only one set of matches would be
	 *                                    found per matching title, since items with
	 *                                    different creators wouldn't match the first
	 *                                    set and the next start row would be a
	 *                                    different title.
	 */
	function processRows(rows, compareRows, reprocessMatches) {
		if (!rows.length) {
			return;
		}
		
		for (var i = 0, len = rows.length; i < len; i++) {
			var j = i + 1, lastMatch = false;
			while (j < len) {
				if (compareRows) {
					var match = compareRows(rows[i], rows[j]);
					// Not a match, and don't try any more with this i value
					if (match == -1) {
						break;
					}
					// Not a match, but keep looking
					if (match == 0) {
						j++;
						continue;
					}
				}
				// If no comparison function, check for exact match
				else {
					if (!rows[i].value || !rows[j].value
						|| (rows[i].value !== rows[j].value)
					) {
						break;
					}
				}
				
				sets.union(
					self._getObjectFromID(rows[i].itemID),
					self._getObjectFromID(rows[j].itemID)
				);
				
				lastMatch = j;
				j++;
			}
			if (!reprocessMatches && lastMatch) {
				i = lastMatch;
			}
		}
	}
	
	// Match books by ISBN
	var sql = "SELECT itemID, value FROM items JOIN itemData USING (itemID) "
				+ "JOIN itemDataValues USING (valueID) "
				+ "WHERE libraryID=? AND itemTypeID=? AND fieldID=? "
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
	var rows = await Zotero.DB.queryAsync(
		sql,
		[
			this._libraryID,
			Zotero.ItemTypes.getID('book'),
			Zotero.ItemFields.getID('ISBN')
		]
	);
	var isbnCache = {};
	if (rows.length) {
		let newRows = [];
		for (let i = 0; i < rows.length; i++) {
			let row = rows[i];
			let newVal = Zotero.Utilities.cleanISBN('' + row.value);
			if (!newVal) continue;
			isbnCache[row.itemID] = newVal;
			newRows.push({
				itemID: row.itemID,
				value: newVal
			});
		}
		newRows.sort(sortByValue);
		processRows(newRows);
	}
	
	// DOI
	var sql = "SELECT itemID, value FROM items JOIN itemData USING (itemID) "
				+ "JOIN itemDataValues USING (valueID) "
				+ "WHERE libraryID=? AND fieldID=? AND value LIKE ? "
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
	var rows = await Zotero.DB.queryAsync(
		sql,
		[
			this._libraryID,
			Zotero.ItemFields.getID('DOI'),
			'10.%'
		]
	);
	var doiCache = {};
	if (rows.length) {
		let newRows = [];
		for (let i = 0; i < rows.length; i++) {
			let row = rows[i];
			// DOIs are case insensitive
			let newVal = (row.value + '').trim().toUpperCase();
			doiCache[row.itemID] = newVal;
			newRows.push({
				itemID: row.itemID,
				value: newVal
			});
		}
		newRows.sort(sortByValue);
		processRows(newRows);
	}
	
	// Get years
	var dateFields = [Zotero.ItemFields.getID('date')].concat(
		Zotero.ItemFields.getTypeFieldsFromBase('date')
	);
	var sql = "SELECT itemID, SUBSTR(value, 1, 4) AS year FROM items "
				+ "JOIN itemData USING (itemID) "
				+ "JOIN itemDataValues USING (valueID) "
				+ "WHERE libraryID=? AND fieldID IN ("
				+ dateFields.map(() => '?').join() + ") "
				+ "AND SUBSTR(value, 1, 4) != '0000' "
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems) "
				+ "ORDER BY value";
	var rows = await Zotero.DB.queryAsync(sql, [this._libraryID].concat(dateFields));
	var yearCache = {};
	for (let i = 0; i < rows.length; i++) {
		let row = rows[i];
		yearCache[row.itemID] = row.year;
	}
	
	var itemTypeAttachment = Zotero.ItemTypes.getID('attachment');
	var itemTypeNote = Zotero.ItemTypes.getID('note');
	
	// Match on normalized title
	var titleIDs = Zotero.ItemFields.getTypeFieldsFromBase('title');
	titleIDs.push(Zotero.ItemFields.getID('title'));
	var sql = "SELECT itemID, value FROM items JOIN itemData USING (itemID) "
				+ "JOIN itemDataValues USING (valueID) "
				+ "WHERE libraryID=? AND fieldID IN "
				+ "(" + titleIDs.join(', ') + ") "
				+ `AND itemTypeID NOT IN (${itemTypeAttachment}, ${itemTypeNote}) `
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)";
	var rows = await Zotero.DB.queryAsync(sql, [this._libraryID]);
	if (rows.length) {
		//normalize all values ahead of time
		rows = rows.map(function (row) {
			return {
				itemID: row.itemID,
				value: normalizeTitle(row.value)
			};
		});
		// Untitled items never match on title
		rows = rows.filter(row => row.value !== "");
		//sort rows by normalized values
		rows.sort(sortByValue);
		
		// Get all creators and separate by itemID
		//
		// We won't need all of these, but otherwise we would have to make processRows()
		// asynchronous, which would be too slow
		let creatorRowsCache = {};
		let sql = "SELECT itemID, lastName, firstName, fieldMode FROM items "
			+ "JOIN itemCreators USING (itemID) "
			+ "JOIN creators USING (creatorID) "
			+ `WHERE libraryID=? AND itemTypeID NOT IN (${itemTypeAttachment}, ${itemTypeNote}) AND `
			+ "itemID NOT IN (SELECT itemID FROM deletedItems)"
			+ "ORDER BY itemID, orderIndex";
		let creatorRows = await Zotero.DB.queryAsync(sql, this._libraryID);
		let lastItemID;
		let itemCreators = [];
		for (let i = 0; i < creatorRows.length; i++) {
			let row = creatorRows[i];
			if (lastItemID && row.itemID != lastItemID) {
				if (itemCreators.length) {
					creatorRowsCache[lastItemID] = itemCreators;
					itemCreators = [];
				}
			}
			
			lastItemID = row.itemID;
			
			itemCreators.push({
				lastName: normalizeString(row.lastName),
				firstInitial: row.fieldMode == 0 ? normalizeString(row.firstName).charAt(0) : false
			});
		}
		// Add final item creators
		if (itemCreators.length) {
			creatorRowsCache[lastItemID] = itemCreators;
		}
		
		// Minimum normalized-title similarity (1 - Levenshtein distance / longer length)
		// for two titles to be considered a fuzzy match
		const TITLE_SIMILARITY_THRESHOLD = 0.9;
		// Titles longer than this are compared for exact equality only, to bound the cost
		// of a pathological pairwise Levenshtein comparison (e.g. an abstract stored as title)
		const TITLE_FUZZY_MAX_LENGTH = 200;
		// Rows are sorted by normalized title, so rows sharing an identical prefix of this
		// length are contiguous and can be grouped into a block for pairwise comparison
		// without comparing the whole library against itself
		const TITLE_BLOCK_PREFIX_LENGTH = 5;
		// Blocks larger than this skip pairwise fuzzy comparison (which would be O(n^2))
		// and fall back to grouping by exact title only
		const TITLE_BLOCK_MAX_SIZE = 25;
		// Number of rows compared across the boundary of two adjacent blocks, to catch a
		// difference that falls within the blocking prefix and would otherwise split an
		// otherwise-matching pair into separate blocks
		const TITLE_BLOCK_BOUNDARY_WINDOW = 3;
		
		function titlesMatch(aTitle, bTitle) {
			if (aTitle === bTitle) {
				return true;
			}
			if (aTitle.length > TITLE_FUZZY_MAX_LENGTH || bTitle.length > TITLE_FUZZY_MAX_LENGTH) {
				return false;
			}
			let maxLen = Math.max(aTitle.length, bTitle.length);
			let ratio = 1 - (Zotero.Utilities.levenshtein(aTitle, bTitle) / maxLen);
			return ratio >= TITLE_SIMILARITY_THRESHOLD;
		}
		
		// Checks all non-title signals used to corroborate (or veto) a title match.
		// Returns 0 (not a dupe) or 1 (all checks passed) -- never -1, since unlike
		// processRows() this isn't relying on sort-order to skip remaining comparisons
		function titleCandidatesCorroborate(a, b) {
			// If both items have a DOI and they don't match, it's not a dupe
			if (typeof doiCache[a.itemID] != 'undefined'
					&& typeof doiCache[b.itemID] != 'undefined'
					&& doiCache[a.itemID] != doiCache[b.itemID]) {
				return 0;
			}
			
			// If both items have an ISBN and they don't match, it's not a dupe
			if (typeof isbnCache[a.itemID] != 'undefined'
					&& typeof isbnCache[b.itemID] != 'undefined'
					&& isbnCache[a.itemID] != isbnCache[b.itemID]) {
				return 0;
			}
			
			// If both items have a year and they're off by more than one, it's not a dupe
			if (typeof yearCache[a.itemID] != 'undefined'
					&& typeof yearCache[b.itemID] != 'undefined'
					&& Math.abs(yearCache[a.itemID] - yearCache[b.itemID]) > 1) {
				return 0;
			}
			
			// If both titles contain a digit run (a year, edition, volume, or part number)
			// and they don't match exactly, it's not a dupe. This is needed because fuzzy
			// title matching would otherwise conflate templated titles that differ only by
			// such a number, e.g. "Annual Report 2019" vs "Annual Report 2018"
			let aDigitRuns = a.value.match(/\d+/g);
			let bDigitRuns = b.value.match(/\d+/g);
			if (aDigitRuns && bDigitRuns
					&& (aDigitRuns.length != bDigitRuns.length
						|| aDigitRuns.some((run, i) => run != bDigitRuns[i]))) {
				return 0;
			}
			
			// Check for at least one match on last name + first initial of first name
			var aCreatorRows, bCreatorRows;
			if (typeof creatorRowsCache[a.itemID] != 'undefined') {
				aCreatorRows = creatorRowsCache[a.itemID];
			}
			if (typeof creatorRowsCache[b.itemID] != 'undefined') {
				bCreatorRows = creatorRowsCache[b.itemID];
			}
			
			// Match if no creators
			if (!aCreatorRows && !bCreatorRows) {
				return 1;
			}
			
			if (!aCreatorRows || !bCreatorRows) {
				return 0;
			}
			
			for (let i = 0; i < aCreatorRows.length; i++) {
				let aCreatorRow = aCreatorRows[i];
				let aLastName = aCreatorRow.lastName;
				let aFirstInitial = aCreatorRow.firstInitial || "";
				
				for (let j = 0; j < bCreatorRows.length; j++) {
					let bCreatorRow = bCreatorRows[j];
					let bLastName = bCreatorRow.lastName;
					let bFirstInitial = bCreatorRow.firstInitial || "";
					
					if (aLastName === bLastName && aFirstInitial === bFirstInitial) {
						return 1;
					}
				}
			}
			
			return 0;
		}
		
		function tryMatchTitleRows(a, b) {
			if (!titlesMatch(a.value, b.value)) {
				return;
			}
			if (!titleCandidatesCorroborate(a, b)) {
				return;
			}
			sets.union(
				self._getObjectFromID(a.itemID),
				self._getObjectFromID(b.itemID)
			);
		}
		
		// Group rows into blocks of contiguous rows (after sorting by normalized title)
		// sharing an identical prefix
		let blocks = [];
		let currentBlock = null;
		let currentKey = null;
		for (let i = 0; i < rows.length; i++) {
			let row = rows[i];
			let key = row.value.length > TITLE_BLOCK_PREFIX_LENGTH
				? row.value.substr(0, TITLE_BLOCK_PREFIX_LENGTH)
				: row.value;
			if (key !== currentKey) {
				currentBlock = [];
				blocks.push(currentBlock);
				currentKey = key;
			}
			currentBlock.push(row);
		}
		
		for (let i = 0; i < blocks.length; i++) {
			let block = blocks[i];
			
			if (block.length > 1) {
				if (block.length <= TITLE_BLOCK_MAX_SIZE) {
					for (let j = 0; j < block.length; j++) {
						for (let k = j + 1; k < block.length; k++) {
							tryMatchTitleRows(block[j], block[k]);
						}
					}
				}
				else {
					Zotero.debug("Duplicates: skipping fuzzy title comparison for oversized "
						+ `block ("${block[0].value}...", ${block.length} items)`);
					// Still catch exact-title duplicates within the block, in groups small
					// enough to compare pairwise cheaply
					let exactGroups = {};
					for (let j = 0; j < block.length; j++) {
						let row = block[j];
						if (!exactGroups[row.value]) {
							exactGroups[row.value] = [];
						}
						exactGroups[row.value].push(row);
					}
					for (let key in exactGroups) {
						let group = exactGroups[key];
						for (let j = 0; j < group.length; j++) {
							for (let k = j + 1; k < group.length; k++) {
								tryMatchTitleRows(group[j], group[k]);
							}
						}
					}
				}
			}
			
			// Compare rows across the boundary with the next block, in case a difference
			// within the blocking prefix split an otherwise-matching pair apart
			if (i + 1 < blocks.length) {
				let tail = block.slice(-TITLE_BLOCK_BOUNDARY_WINDOW);
				let head = blocks[i + 1].slice(0, TITLE_BLOCK_BOUNDARY_WINDOW);
				for (let j = 0; j < tail.length; j++) {
					for (let k = 0; k < head.length; k++) {
						tryMatchTitleRows(tail[j], head[k]);
					}
				}
			}
			
			if (i % 20 == 0) {
				await Zotero.Promise.delay(0);
			}
		}
	}
	
	// Match on exact fields
	/*var fields = [''];
	for (let field of fields) {
		var sql = "SELECT itemID, value FROM items JOIN itemData USING (itemID) "
					+ "JOIN itemDataValues USING (valueID) "
					+ "WHERE libraryID=? AND fieldID=? "
					+ "AND itemID NOT IN (SELECT itemID FROM deletedItems) "
					+ "ORDER BY value";
		var rows = yield Zotero.DB.queryAsync(sql, [this._libraryID, Zotero.ItemFields.getID(field)]);
		processRows(rows);
	}*/
	
	Zotero.debug("Found duplicates in " + (Date.now() - start) + " ms");
};



/**
 * Implements the Disjoint Set data structure
 *
 *  Based on pseudo-code from http://en.wikipedia.org/wiki/Disjoint-set_data_structure
 *
 * Objects passed should have .id properties that uniquely identify them
 */

Zotero.DisjointSetForest = function () {
	this._objects = {};
}

Zotero.DisjointSetForest.prototype.find = function (x) {
	var id = x.id;
	
	// If we've seen this object before, use the existing copy,
	// which will have .parent and .rank properties
	if (this._objects[id]) {
		var obj = this._objects[id];
	}
	// Otherwise initialize it as a new set
	else {
		this._makeSet(x);
		this._objects[id] = x;
		var obj = x;
	}
	
	if (obj.parent.id == obj.id) {
		return obj;
	}
	else {
		obj.parent = this.find(obj.parent);
		return obj.parent;
	}
}


Zotero.DisjointSetForest.prototype.union = function (x, y) {
	var xRoot = this.find(x);
	var yRoot = this.find(y);
	
	// Already in same set
	if (xRoot.id == yRoot.id) {
		return;
	}
	
	if (xRoot.rank < yRoot.rank) {
		xRoot.parent = yRoot;
	}
	else if (xRoot.rank > yRoot.rank) {
		yRoot.parent = xRoot;
	}
	else {
		yRoot.parent = xRoot;
		xRoot.rank = xRoot.rank + 1;
	}
}


Zotero.DisjointSetForest.prototype.sameSet = function (x, y) {
    return this.find(x) == this.find(y);
}


Zotero.DisjointSetForest.prototype.findAll = function (asIDs) {
	var objects = [];
	for (let i in this._objects) {
		let obj = this._objects[i];
		objects.push(asIDs ? obj.id : obj);
	}
	return objects;
}


Zotero.DisjointSetForest.prototype.findAllInSet = function (x, asIDs) {
	var xRoot = this.find(x);
	var objects = [];
	for (let i in this._objects) {
		let obj = this._objects[i];
		if (this.find(obj) == xRoot) {
			objects.push(asIDs ? obj.id : obj);
		}
	}
	return objects;
}


Zotero.DisjointSetForest.prototype._makeSet = function (x) {
	x.parent = x;
	x.rank = 0;
}
