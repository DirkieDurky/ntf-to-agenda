import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import config from './config.json' with { type: 'json' };
import * as util from 'util';
import _ from 'lodash';

export async function extractTargetShiftsFromPdf(pdfBuffer, filename) {
	// const pdf = await pdfjsLib.getDocument({ data: attachmentArrayBuffer }).promise;
	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(pdfBuffer)
	});

	const pdf = await loadingTask.promise;

	let relevantPage = null;
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		if (content.items[0].str === "Op naam" && content.items.some(i => i.str === config.targetName)) {
			relevantPage = await page.getTextContent();
		}
	}

	// console.log("relevantPage:");
	// console.log(relevantPage);

	const yearRegex = /Weekplanning \(\d{2}-\d{2}-(\d{4})-\d{2}-\d{2}-(\d{4})\).pdf/;
	let matches = filename.match(yearRegex);
	const startYear = parseInt(matches[1]);
	const endYear = parseInt(matches[2]);

	const dateRegex = /\w\w \((\d\d) - (\d\d)\)/;
	const timeRegex = /(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/;

	const dates = new Map();
	for (let item of relevantPage.items) {
		if ((matches = item.str.match(dateRegex)) !== null) {
			const day = parseInt(matches[1]);
			const month = parseInt(matches[2]);
			const year = (startYear !== endYear && parseInt(matches[2]) == 1) ? endYear : startYear;
			dates.set(item.transform[4], new Date(year + '-' + month + '-' + day));
		}
	}
	// console.log("dates:");
	// console.log(dates);

	const shifts = [];

	let rowStartX = null;
	for (let i = 0; i < relevantPage.items.length; i++) {
		const item = relevantPage.items[i];
		if (rowStartX === null) {
			if (item.str == config.targetName) {
				rowStartX = item.transform[4];
				// console.log("Found x at start of row:");
				// console.log(rowStartX);
			}
			continue;
		}

		if (item.transform[4] <= rowStartX) break;

		if ((matches = item.str.match(timeRegex)) !== null) {
			const date = dates.get(item.transform[4]);
			const startDateTime = new Date(date.getTime());
			startDateTime.setHours(matches[1]);
			startDateTime.setMinutes(matches[2]);
			const endDateTime = new Date(date.getTime());
			endDateTime.setHours(matches[3]);
			endDateTime.setMinutes(matches[4]);
			shifts.push({
				type: relevantPage.items[i - 2].str,
				startDateTime: startDateTime,
				endDateTime: endDateTime,
			});
		}
	}

	// console.log(shifts);
	return shifts;
}

export async function extractAllShiftsFromPdf(pdfBuffer, filename) {
	// const loadingTask = pdfjsLib.getDocument(filename);
	const loadingTask = pdfjsLib.getDocument({
		data: new Uint8Array(pdfBuffer)
	});

	const pdf = await loadingTask.promise;

	let relevantPages = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		if (content.items[0].str === "Op naam") {
			relevantPages.push(await page.getTextContent());
		}
	}
	// console.log("relevantPages:");
	// process.stdout.write(util.inspect(relevantPages, { showHidden: false, depth: null, colors: true, maxArrayLength: null }));

	const yearRegex = /Weekplanning \(\d{2}-\d{2}-(\d{4})-\d{2}-\d{2}-(\d{4})\).pdf/;
	let matches = filename.match(yearRegex);
	const startYear = parseInt(matches[1]);
	const endYear = parseInt(matches[2]);

	const dateRegex = /\w\w \((\d\d) - (\d\d)\)/;
	const timeRegex = /(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/;

	// Map the x values of the columns corresponding to each day
	const datesByX = new Map();
	for (let item of relevantPages[0].items) {
		if ((matches = item.str.match(dateRegex)) !== null) {
			const day = parseInt(matches[1]);
			const month = parseInt(matches[2]);
			const year = (startYear !== endYear && parseInt(matches[2]) == 1) ? endYear : startYear;
			datesByX.set(item.transform[4], new Date(year + '-' + month + '-' + day));
		}
	}
	// console.log("datesByX:");
	// console.log(datesByX);

	// Get the x value from the first item and use that value to find when a new line begins
	const rowStartX = relevantPages[0].items[0].transform[4];

	const shiftsByDate = new Map();
	const shiftsByEmployee = new Map();

	let currentEmployee = "";
	let currentType = "";
	let currentTypeX = null;
	let lastX = rowStartX;

	for (let page of relevantPages) {
		for (let i = 0; i < page.items.length; i++) {
			const item = page.items[i];
			const x = item.transform[4];
			if (item.str === "") continue;
			if (item.fontName !== "g_d0_f2") continue;
			// if (item.str === "Op naam") continue;
			// if (item.str === "Dienst") continue;

			if (x === rowStartX) {
				if (lastX > x) {
					currentEmployee = item.str;
				} else {
					currentEmployee += " " + item.str;
				}
			}

			if (/^\w+$/.test(item.str) && x !== rowStartX
				// && item.str !== "Totaal"
			) {
				currentType = item.str;
				currentTypeX = x;
			}

			if ((matches = item.str.match(timeRegex)) !== null) {
				const date = datesByX.get(x);
				const startDateTime = new Date(date.getTime());
				startDateTime.setHours(matches[1]);
				startDateTime.setMinutes(matches[2]);
				const endDateTime = new Date(date.getTime());
				endDateTime.setHours(matches[3]);
				endDateTime.setMinutes(matches[4]);
				const newShift = {
					date: date,
					employeeName: currentEmployee,
					type: currentTypeX == x ? currentType : null,
					startDateTime: startDateTime,
					endDateTime: endDateTime,
				};
				if (!shiftsByDate.has(date)) shiftsByDate.set(date, []);
				shiftsByDate.get(date).push(newShift);
				if (!shiftsByEmployee.has(currentEmployee)) shiftsByEmployee.set(currentEmployee, []);
				shiftsByEmployee.get(currentEmployee).push(newShift);
			}

			lastX = x;
		}
	}

	// console.log(shiftsByDate);
	// console.log(shiftsByEmployee);
	return { byDate: shiftsByDate, byEmployee: shiftsByEmployee };
}
