interface Mapping {
    [key: string]: string;
}

const mapModel: Mapping = {
    "Codestral": "AI V1",
}

const mapProvider: Mapping = {
    "Mistral": "AI TLU",
}

export const mapModelTitle = (modelTitle: string): string => {
    return mapModel[modelTitle] || "";
}

export const mapProviderTitle = (providerTitle: string): string => {
    return mapProvider[providerTitle] || "";
}