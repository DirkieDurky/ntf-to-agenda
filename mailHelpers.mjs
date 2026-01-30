import 'dotenv/config';

export function findAttachments(node, path = []) {
    let attachments = [];

    if (node.disposition === 'attachment' ||
        (node.type && node.type !== 'text' && node.type !== 'multipart' && !node.disposition)) {
        attachments.push({
            part: path.length ? path.join('.') : '1',
            type: `${node.type}/${node.subtype || 'octet-stream'}`,
            size: node.size,
            filename: node.dispositionParameters?.filename ||
                node.parameters?.name ||
                'unnamed'
        });
    }

    if (node.childNodes) {
        node.childNodes.forEach((child, i) => {
            attachments.push(...findAttachments(child, [...path, i + 1]));
        });
    }

    return attachments;
}

export async function downloadAttachment(client, messageUid, attachmentPart) {
    const { content } = await client.download(messageUid, attachmentPart, { uid: true });

    const chunks = [];
    for await (const chunk of content) {
        chunks.push(chunk);
    }

    const pdfBuffer = Buffer.concat(chunks);
    return pdfBuffer;
}
