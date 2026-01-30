import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import 'dotenv/config';

export async function extractShiftsFromPdf(pdfBuffer, filename) {
    // const pdf = await pdfjsLib.getDocument({ data: attachmentArrayBuffer }).promise;
    const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(pdfBuffer)
    });

    const pdf = await loadingTask.promise;

    let relevantPage = null;
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        if (content.items[0].str === "Op naam" && content.items.some(i => i.str === process.env.TARGET_NAME)) {
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
            if (item.str == process.env.TARGET_NAME) {
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
