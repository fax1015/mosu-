const { parentPort, workerData } = require('worker_threads');
const fs = require('fs/promises');


const BUFFER_SIZE = 8192;
const ESTIMATED_HIT_OBJECTS_PER_KB = 20;
const PROGRESS_REPORT_INTERVAL = 25;

const CHAR_CODES = {
    NEWLINE: 10,
    CARRIAGE_RETURN: 13,
    SPACE: 32,
    TAB: 9,
    OPEN_BRACKET: 91,
    CLOSE_BRACKET: 93,
    COLON: 58,
    COMMA: 44,
    QUOTE: 34,
    SLASH: 47,
    ZERO: 48,
    TWO: 50,
};

const SECTIONS = {
    NONE: 0,
    GENERAL: 1,
    EDITOR: 2,
    METADATA: 3,
    DIFFICULTY: 4,
    EVENTS: 5,
    TIMING_POINTS: 6,
    COLOURS: 7,
    HIT_OBJECTS: 8
};


/**
 * Fast integer parsing from string without creating substrings
 * @param {string} str - Source string
 * @param {number} start - Start index
 * @param {number} end - End index
 * @returns {number|null} Parsed integer or null if invalid
 */
const fastParseInt = (str, start, end) => {
    let result = 0;
    let sign = 1;
    let i = start;

    while (i < end && (str.charCodeAt(i) === CHAR_CODES.SPACE || str.charCodeAt(i) === CHAR_CODES.TAB)) {
        i++;
    }

    const charCode = str.charCodeAt(i);
    if (charCode === 45) {
        sign = -1;
        i++;
    } else if (charCode === 43) {
        i++;
    }

    let hasDigit = false;
    while (i < end) {
        const digit = str.charCodeAt(i) - CHAR_CODES.ZERO;
        if (digit < 0 || digit > 9) break;
        result = result * 10 + digit;
        hasDigit = true;
        i++;
    }

    return hasDigit ? result * sign : null;
};

/**
 * Extract substring and trim whitespace without intermediate allocations
 * @param {string} str - Source string
 * @param {number} start - Start index
 * @param {number} end - End index
 * @returns {string} Trimmed substring
 */
const extractTrimmed = (str, start, end) => {
    while (start < end && (str.charCodeAt(start) === CHAR_CODES.SPACE ||
        str.charCodeAt(start) === CHAR_CODES.TAB)) {
        start++;
    }

    while (end > start && (str.charCodeAt(end - 1) === CHAR_CODES.SPACE ||
        str.charCodeAt(end - 1) === CHAR_CODES.TAB)) {
        end--;
    }

    return str.slice(start, end);
};

/**
 * Check if string matches at position (case-insensitive, without toLowerCase())
 * @param {string} str - Source string
 * @param {number} pos - Position to check
 * @param {string} match - String to match (lowercase)
 * @returns {boolean}
 */
const matchesAt = (str, pos, match) => {
    if (pos + match.length > str.length) return false;

    for (let i = 0; i < match.length; i++) {
        const charCode = str.charCodeAt(pos + i);
        const matchCode = match.charCodeAt(i);

        const lowerCharCode = (charCode >= 65 && charCode <= 90) ? charCode + 32 : charCode;
        if (lowerCharCode !== matchCode) return false;
    }

    return true;
};

/**
 * Identify section from header line
 * @param {string} str - Line content
 * @param {number} start - Start of section name (after '[')
 * @param {number} end - End of section name (before ']')
 * @returns {number} Section identifier
 */
const identifySection = (str, start, end) => {
    const length = end - start;

    switch (length) {
        case 6:
            if (matchesAt(str, start, 'editor')) return SECTIONS.EDITOR;
            if (matchesAt(str, start, 'events')) return SECTIONS.EVENTS;
            if (matchesAt(str, start, 'colours')) return SECTIONS.COLOURS;
            break;
        case 7:
            if (matchesAt(str, start, 'general')) return SECTIONS.GENERAL;
            break;
        case 8:
            if (matchesAt(str, start, 'metadata')) return SECTIONS.METADATA;
            break;
        case 10:
            if (matchesAt(str, start, 'difficulty')) return SECTIONS.DIFFICULTY;
            if (matchesAt(str, start, 'hitobjects')) return SECTIONS.HIT_OBJECTS;
            break;
        case 12:
            if (matchesAt(str, start, 'timingpoints')) return SECTIONS.TIMING_POINTS;
            break;
    }

    return SECTIONS.NONE;
};

/**
 * Check if extension is an image file
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
const isImageExtension = (filename) => {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) return false;

    const ext = filename.slice(lastDot + 1).toLowerCase();
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' ||
        ext === 'webp' || ext === 'gif' || ext === 'bmp';
};


/**
 * Parse entire .osu file in a single pass
 * Extracts metadata, hit objects, breaks, and bookmarks without redundant operations
 * 
 * @param {string} content - Full file content
 * @returns {Object} Parsed data structure
 */
const parseOsuFile = (content) => {
    const result = {
        metadata: {
            title: '',
            artist: '',
            creator: '',
            version: '',
            audio: '',
            background: '',
            beatmapSetID: '',
            previewTime: -1
        },
        hitStarts: null,
        hitEnds: null,
        breakPeriods: [],
        bookmarks: []
    };

    let sliderMultiplier = 1.0;
    const timingPoints = [];

    const estimatedHitObjects = Math.ceil(content.length / 1024 * ESTIMATED_HIT_OBJECTS_PER_KB);
    let hitStartsArray = new Int32Array(Math.max(estimatedHitObjects, 100));
    let hitEndsArray = new Int32Array(Math.max(estimatedHitObjects, 100));
    let hitTypesArray = new Int16Array(Math.max(estimatedHitObjects, 100));
    let hitCount = 0;

    let section = SECTIONS.NONE;
    let lineStart = 0;

    if (content.charCodeAt(0) === 0xFEFF) {
        lineStart = 1;
    }

    const contentLength = content.length;

    for (let i = 0; i <= contentLength; i++) {
        const char = i < contentLength ? content.charCodeAt(i) : CHAR_CODES.NEWLINE;

        if (char === CHAR_CODES.NEWLINE || char === CHAR_CODES.CARRIAGE_RETURN || i === contentLength) {
            if (char === CHAR_CODES.CARRIAGE_RETURN &&
                i + 1 < contentLength &&
                content.charCodeAt(i + 1) === CHAR_CODES.NEWLINE) {
                i++;
            }

            let lineEnd = i;

            while (lineStart < lineEnd &&
                (content.charCodeAt(lineStart) === CHAR_CODES.SPACE ||
                    content.charCodeAt(lineStart) === CHAR_CODES.TAB)) {
                lineStart++;
            }

            while (lineEnd > lineStart &&
                (content.charCodeAt(lineEnd - 1) === CHAR_CODES.SPACE ||
                    content.charCodeAt(lineEnd - 1) === CHAR_CODES.TAB ||
                    content.charCodeAt(lineEnd - 1) === CHAR_CODES.CARRIAGE_RETURN ||
                    content.charCodeAt(lineEnd - 1) === CHAR_CODES.NEWLINE)) {
                lineEnd--;
            }

            const lineLength = lineEnd - lineStart;

            if (lineLength === 0) {
                lineStart = i + 1;
                continue;
            }

            if (lineLength >= 2 &&
                content.charCodeAt(lineStart) === CHAR_CODES.SLASH &&
                content.charCodeAt(lineStart + 1) === CHAR_CODES.SLASH) {
                lineStart = i + 1;
                continue;
            }

            if (content.charCodeAt(lineStart) === CHAR_CODES.OPEN_BRACKET &&
                content.charCodeAt(lineEnd - 1) === CHAR_CODES.CLOSE_BRACKET) {
                section = identifySection(content, lineStart + 1, lineEnd - 1);
                lineStart = i + 1;
                continue;
            }

            switch (section) {
                case SECTIONS.METADATA:
                    parseMetadataLine(content, lineStart, lineEnd, result.metadata);
                    break;

                case SECTIONS.GENERAL:
                    parseGeneralLine(content, lineStart, lineEnd, result.metadata);
                    break;

                case SECTIONS.EVENTS:
                    parseEventLine(content, lineStart, lineEnd, result.metadata, result.breakPeriods);
                    break;

                case SECTIONS.EDITOR:
                    parseEditorLine(content, lineStart, lineEnd, result.bookmarks);
                    break;

                case SECTIONS.DIFFICULTY:
                    const sm = parseSliderMultiplier(content, lineStart, lineEnd);
                    if (sm !== null) sliderMultiplier = sm;
                    break;

                case SECTIONS.TIMING_POINTS:
                    const tp = parseTimingPoint(content, lineStart, lineEnd);
                    if (tp !== null) timingPoints.push(tp);
                    break;

                case SECTIONS.HIT_OBJECTS:
                    const object = parseHitObject(content, lineStart, lineEnd, sliderMultiplier, timingPoints);
                    if (object !== null) {
                        if (hitCount > 0) {
                            const prevType = hitTypesArray[hitCount - 1];
                            if (prevType & 2) {
                                hitEndsArray[hitCount - 1] = Math.max(hitEndsArray[hitCount - 1], object.start);
                            }
                        }

                        if (hitCount >= hitStartsArray.length) {
                            const newStarts = new Int32Array(hitStartsArray.length * 2);
                            const newEnds = new Int32Array(hitEndsArray.length * 2);
                            const newTypes = new Int16Array(hitTypesArray.length * 2);
                            newStarts.set(hitStartsArray);
                            newEnds.set(hitEndsArray);
                            newTypes.set(hitTypesArray);
                            hitStartsArray = newStarts;
                            hitEndsArray = newEnds;
                            hitTypesArray = newTypes;
                        }
                        hitStartsArray[hitCount] = object.start;
                        hitEndsArray[hitCount] = object.end;
                        hitTypesArray[hitCount] = object.type;
                        hitCount++;
                    }
                    break;
            }

            lineStart = i + 1;
        }
    }

    // Trim hit times array to actual size
    result.hitStarts = hitCount > 0 ? hitStartsArray.slice(0, hitCount) : new Int32Array(0);
    result.hitEnds = hitCount > 0 ? hitEndsArray.slice(0, hitCount) : new Int32Array(0);

    return result;
};

/**
 * Parse SliderMultiplier from line
 */
const parseSliderMultiplier = (content, start, end) => {
    const colonIdx = content.indexOf(':', start);
    if (colonIdx === -1 || colonIdx >= end) return null;
    const key = extractTrimmed(content, start, colonIdx).toLowerCase();
    if (key === 'slidermultiplier') {
        const val = extractTrimmed(content, colonIdx + 1, end);
        return parseFloat(val) || 1.0;
    }
    return null;
};

/**
 * Parse TimingPoint from line
 * Format: time,beatLength,meter,sampleSet,sampleIndex,volume,uninherited,effects
 */
const parseTimingPoint = (content, start, end) => {
    const parts = extractTrimmed(content, start, end).split(',');
    if (parts.length < 2) return null;
    return {
        time: parseInt(parts[0]),
        beatLength: parseFloat(parts[1]),
        uninherited: parts.length > 6 ? parts[6] === '1' : true
    };
};

/**
 * Get active timing info for a given time
 */
const getTimingInfo = (time, timingPoints) => {
    let activeBPM = 60000 / 120; // fallback 120bpm
    let activeSV = 1.0;

    for (const tp of timingPoints) {
        if (tp.time > time) break;
        if (tp.uninherited) {
            activeBPM = tp.beatLength;
            activeSV = 1.0;
        } else {
            // Inherited points have negative beatLength representing -100/multiplier
            if (tp.beatLength < 0) {
                activeSV = -100 / tp.beatLength;
            } else {
                activeSV = 1.0;
            }
        }
    }
    return { beatLength: activeBPM, sv: activeSV };
};

/**
 * Parse HitObject from line
 * Format: x,y,time,type,hitSound,objectParams...
 */
const parseHitObject = (content, lineStart, lineEnd, sliderMultiplier, timingPoints) => {
    const line = extractTrimmed(content, lineStart, lineEnd);
    const parts = line.split(',');
    if (parts.length < 4) return null;

    const time = parseInt(parts[2]);
    const type = parseInt(parts[3]);
    let endTime = time;

    // Check if it's a slider (bit 1 / value 2)
    if (type & 2) {
        if (parts.length >= 8) {
            const slides = parseInt(parts[6]) || 1;
            const length = parseFloat(parts[7]) || 0;
            const timing = getTimingInfo(time, timingPoints);

            // Slider duration = (length / (SliderMultiplier * 100 * SV)) * beatLength * slides
            // SV in timing points is already handled by our getTimingInfo (activeSV)
            const duration = (length / (sliderMultiplier * 100 * timing.sv)) * timing.beatLength * slides;
            endTime = time + Math.max(0, Math.floor(duration));
        }
    }
    // Check if it's a spinner (bit 3 / value 8)
    else if (type & 8) {
        if (parts.length >= 6) {
            endTime = parseInt(parts[5]) || time;
        }
    }
    // Mania hold notes (LN) use bit 7 / value 128
    else if (type & 128) {
        if (parts.length >= 6) {
            // Mania syntax for LNs: x,y,time,type,hitSound,endTime:hitSample
            const lnEndPart = parts[5].split(':')[0];
            endTime = parseInt(lnEndPart) || time;
        }
    }

    return { start: time, end: Math.max(time, endTime), type };
};

/**
 * Parse a line from [Metadata] section
 */
const parseMetadataLine = (content, start, end, metadata) => {
    const colonIdx = content.indexOf(':', start);
    if (colonIdx === -1 || colonIdx >= end) return;

    const key = extractTrimmed(content, start, colonIdx).toLowerCase();
    const value = extractTrimmed(content, colonIdx + 1, end);

    switch (key) {
        case 'title':
            metadata.title = value;
            break;
        case 'artist':
            metadata.artist = value;
            break;
        case 'creator':
            metadata.creator = value;
            break;
        case 'version':
            metadata.version = value;
            break;
        case 'beatmapsetid':
            const id = fastParseInt(value, 0, value.length);
            if (id !== null && id > 0) {
                metadata.beatmapSetID = `https://osu.ppy.sh/beatmapsets/${id}`;
            } else {
                metadata.beatmapSetID = value;
            }
            break;
    }
};

/**
 * Parse a line from [General] section
 */
const parseGeneralLine = (content, start, end, metadata) => {
    const colonIdx = content.indexOf(':', start);
    if (colonIdx === -1 || colonIdx >= end) return;

    const key = extractTrimmed(content, start, colonIdx).toLowerCase();

    if (key === 'audiofilename') {
        metadata.audio = extractTrimmed(content, colonIdx + 1, end);
    } else if (key === 'previewtime') {
        const pTime = fastParseInt(content, colonIdx + 1, end);
        if (pTime !== null) metadata.previewTime = pTime;
    }
};

/**
 * Parse a line from [Events] section
 */
const parseEventLine = (content, start, end, metadata, breakPeriods) => {
    const firstChar = content.charCodeAt(start);

    // Background: "0,0,"filename",..."
    if (firstChar === CHAR_CODES.ZERO &&
        start + 1 < end &&
        content.charCodeAt(start + 1) === CHAR_CODES.COMMA) {

        let commaCount = 0;
        let bgStart = -1;
        let bgEnd = -1;

        for (let j = start; j < end; j++) {
            if (content.charCodeAt(j) === CHAR_CODES.COMMA) {
                commaCount++;
                if (commaCount === 2) {
                    bgStart = j + 1;
                } else if (commaCount === 3) {
                    bgEnd = j;
                    break;
                }
            }
        }

        if (bgStart !== -1) {
            if (bgEnd === -1) bgEnd = end;

            // Trim and remove quotes
            while (bgStart < bgEnd &&
                (content.charCodeAt(bgStart) === CHAR_CODES.SPACE ||
                    content.charCodeAt(bgStart) === CHAR_CODES.TAB ||
                    content.charCodeAt(bgStart) === CHAR_CODES.QUOTE)) {
                bgStart++;
            }
            while (bgEnd > bgStart &&
                (content.charCodeAt(bgEnd - 1) === CHAR_CODES.SPACE ||
                    content.charCodeAt(bgEnd - 1) === CHAR_CODES.TAB ||
                    content.charCodeAt(bgEnd - 1) === CHAR_CODES.QUOTE)) {
                bgEnd--;
            }

            const bg = content.slice(bgStart, bgEnd);

            // Only use image files, filter out videos
            if (isImageExtension(bg)) {
                metadata.background = bg;
            }
        }
    }
    // Break period: "2,startTime,endTime"
    else if (firstChar === CHAR_CODES.TWO &&
        start + 1 < end &&
        content.charCodeAt(start + 1) === CHAR_CODES.COMMA) {

        let commaCount = 0;
        let breakStart = -1;
        let breakStartIdx = -1;
        let breakEnd = -1;

        let numStart = start;
        for (let j = start; j < end; j++) {
            if (content.charCodeAt(j) === CHAR_CODES.COMMA) {
                commaCount++;
                if (commaCount === 1) {
                    numStart = j + 1;
                } else if (commaCount === 2) {
                    breakStart = fastParseInt(content, numStart, j);
                    breakStartIdx = j + 1;
                } else if (commaCount === 3) {
                    breakEnd = fastParseInt(content, breakStartIdx, j);
                    break;
                }
            }
        }

        // Handle case where there's no 4th comma
        if (commaCount === 2 && breakStartIdx !== -1) {
            breakEnd = fastParseInt(content, breakStartIdx, end);
        }

        if (breakStart !== null && breakEnd !== null) {
            breakPeriods.push({ start: breakStart, end: breakEnd });
        }
    }
};

/**
 * Parse a line from [Editor] section
 */
const parseEditorLine = (content, start, end, bookmarks) => {
    // Check for "Bookmarks:"
    if (matchesAt(content, start, 'bookmarks:')) {
        const bookmarksStart = start + 10;

        // Parse comma-separated integers
        let numStart = bookmarksStart;
        for (let j = bookmarksStart; j <= end; j++) {
            if (j === end || content.charCodeAt(j) === CHAR_CODES.COMMA) {
                if (j > numStart) {
                    const trimStart = numStart;
                    const trimEnd = j;
                    const num = fastParseInt(content, trimStart, trimEnd);
                    if (num !== null) {
                        bookmarks.push(num);
                    }
                }
                numStart = j + 1;
            }
        }
    }
};

/**
 * Parse hit object time from line
 * Format: x,y,time,type,hitSound,...
 */
const parseHitObjectTime = (content, start, end) => {
    let commaCount = 0;
    let timeStart = -1;

    for (let j = start; j < end; j++) {
        if (content.charCodeAt(j) === CHAR_CODES.COMMA) {
            commaCount++;
            if (commaCount === 2) {
                timeStart = j + 1;
            } else if (commaCount === 3) {
                return fastParseInt(content, timeStart, j);
            }
        }
    }

    // Handle case where there's no 4th comma
    if (commaCount === 2 && timeStart !== -1) {
        return fastParseInt(content, timeStart, end);
    }

    return null;
};

/**
 * Read only the header portion of a file (first 8KB)
 * Used for quick metadata extraction when filtering by mapper
 * 
 * @param {string} filePath - Path to .osu file
 * @returns {Promise<string>} Header content
 */
const readOsuHeader = async (filePath) => {
    let fileHandle;
    try {
        fileHandle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(BUFFER_SIZE);
        const { bytesRead } = await fileHandle.read(buffer, 0, BUFFER_SIZE, 0);
        let content = buffer.toString('utf8', 0, bytesRead);
        // Remove UTF-8 BOM if present (\uFEFF)
        if (content.startsWith('\uFEFF')) {
            content = content.slice(1);
        }
        return content;
    } catch {
        return '';
    } finally {
        if (fileHandle) await fileHandle.close();
    }
};

/**
 * Parse creator and version from header content
 * 
 * @param {string} content - Header content
 * @returns {Object} { creator: string, version: string }
 */
const parseMetadataFromHeader = (content) => {
    const meta = { creator: '', version: '' };
    let section = '';
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            section = trimmed.slice(1, -1).toLowerCase();
            continue;
        }

        if (section === 'metadata') {
            const sep = trimmed.indexOf(':');
            if (sep === -1) continue;
            const key = trimmed.slice(0, sep).trim().toLowerCase();
            const val = trimmed.slice(sep + 1).trim();

            if (key === 'creator') {
                meta.creator = val;
            } else if (key === 'version') {
                meta.version = val;
            }

            // Early exit once we have both
            if (meta.creator && meta.version) {
                break;
            }
        }
    }

    return meta;
};

/**
 * Batch stat operations with concurrency limit
 * Prevents overwhelming the filesystem with too many concurrent operations
 * 
 * @param {Array<string>} filePaths - Array of file paths
 * @param {number} concurrency - Maximum concurrent operations
 * @returns {Promise<Array>} Array of stat results
 */
const batchStatFiles = async (filePaths, concurrency = 100) => {
    const results = new Array(filePaths.length);
    let index = 0;

    const processNext = async () => {
        while (index < filePaths.length) {
            const currentIndex = index++;
            const filePath = filePaths[currentIndex];

            try {
                const stat = await fs.stat(filePath);
                results[currentIndex] = { path: filePath, stat, error: null };
            } catch (error) {
                results[currentIndex] = { path: filePath, stat: null, error: error.message };
            }
        }
    };

    // Create worker pool
    const workers = Array(Math.min(concurrency, filePaths.length))
        .fill(null)
        .map(() => processNext());

    await Promise.all(workers);
    return results;
};

/**
 * Process all files assigned to this worker
 */
const processFiles = async () => {
    const { filePaths, mapperName, knownFiles } = workerData;
    const results = [];
    const needle = mapperName ? mapperName.toLowerCase() : null;
    const transferList = [];
    const errors = [];

    const totalFiles = filePaths.length;
    let processedCount = 0;
    let skippedCount = 0;
    let cachedCount = 0;
    let errorCount = 0;

    const statResults = await batchStatFiles(filePaths);

    for (let i = 0; i < statResults.length; i++) {
        const statResult = statResults[i];

        // Handle stat errors
        if (!statResult.stat) {
            errorCount++;
            errors.push({
                filePath: statResult.path,
                error: statResult.error || 'Failed to stat file',
                phase: 'stat'
            });
            processedCount++;
            continue;
        }

        const { path: filePath, stat } = statResult;
        const mtime = stat.mtimeMs;

        try {
            // Check if file is cached
            if (knownFiles && knownFiles[filePath] === mtime) {
                // File is cached, but we still need to check mapper filter
                if (needle) {
                    // Read header to check if it matches the filter
                    const header = await readOsuHeader(filePath);
                    const metadata = parseMetadataFromHeader(header);
                    const creator = metadata.creator.toLowerCase();
                    const version = metadata.version.toLowerCase();

                    // Skip if doesn't match mapper name
                    if (!creator.includes(needle) && !version.includes(needle)) {
                        skippedCount++;
                        processedCount++;

                        // Report progress periodically
                        if (processedCount % PROGRESS_REPORT_INTERVAL === 0 || processedCount === totalFiles) {
                            parentPort.postMessage({
                                type: 'progress',
                                processed: processedCount,
                                total: totalFiles,
                                cached: cachedCount,
                                skipped: skippedCount,
                                errors: errorCount
                            });
                        }

                        continue;
                    }
                }

                // File is cached AND matches filter (or no filter) - add it
                results.push({
                    filePath,
                    stat: { mtimeMs: mtime },
                    unchanged: true
                });
                cachedCount++;
                processedCount++;

                // Report progress periodically
                if (processedCount % PROGRESS_REPORT_INTERVAL === 0 || processedCount === totalFiles) {
                    parentPort.postMessage({
                        type: 'progress',
                        processed: processedCount,
                        total: totalFiles,
                        cached: cachedCount,
                        skipped: skippedCount,
                        errors: errorCount
                    });
                }

                continue;
            }

            if (needle) {
                const header = await readOsuHeader(filePath);
                const metadata = parseMetadataFromHeader(header);
                const creator = metadata.creator.toLowerCase();
                const version = metadata.version.toLowerCase();

                // Skip if doesn't match mapper name
                if (!creator.includes(needle) && !version.includes(needle)) {
                    skippedCount++;
                    processedCount++;

                    // Report progress periodically
                    if (processedCount % PROGRESS_REPORT_INTERVAL === 0 || processedCount === totalFiles) {
                        parentPort.postMessage({
                            type: 'progress',
                            processed: processedCount,
                            total: totalFiles,
                            cached: cachedCount,
                            skipped: skippedCount,
                            errors: errorCount
                        });
                    }

                    continue;
                }
            }

            const content = await fs.readFile(filePath, 'utf8');
            const parsed = parseOsuFile(content);

            // Transfer TypedArray buffer for zero-copy performance
            if (parsed.hitStarts && parsed.hitStarts.buffer) {
                transferList.push(parsed.hitStarts.buffer);
            }
            if (parsed.hitEnds && parsed.hitEnds.buffer) {
                transferList.push(parsed.hitEnds.buffer);
            }

            results.push({
                filePath,
                metadata: parsed.metadata,
                hitStarts: parsed.hitStarts,
                hitEnds: parsed.hitEnds,
                breakPeriods: parsed.breakPeriods,
                bookmarks: parsed.bookmarks,
                stat: { mtimeMs: mtime }
            });

        } catch (error) {
            errorCount++;
            errors.push({
                filePath,
                error: error.message,
                phase: 'parse',
                stack: error.stack
            });
        }

        processedCount++;

        // Report progress periodically
        if (processedCount % PROGRESS_REPORT_INTERVAL === 0 || processedCount === totalFiles) {
            parentPort.postMessage({
                type: 'progress',
                processed: processedCount,
                total: totalFiles,
                cached: cachedCount,
                skipped: skippedCount,
                errors: errorCount
            });
        }
    }

    parentPort.postMessage({
        type: 'complete',
        results,
        stats: {
            total: totalFiles,
            processed: results.length,
            cached: cachedCount,
            skipped: skippedCount,
            errors: errorCount,
            errorDetails: errors.length > 0 ? errors : undefined
        }
    }, transferList);
};

// Start processing when worker is loaded
processFiles().catch(error => {
    // Send fatal error back to main thread
    parentPort.postMessage({
        type: 'error',
        error: error.message,
        stack: error.stack
    });
});