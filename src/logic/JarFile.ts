import { combineLatest, debounceTime, distinctUntilChanged, map, Observable, switchMap } from 'rxjs';
import { minecraftJar } from './MinecraftApi';
import { performSearch } from './Search';
import { searchQuery } from './State';

export const fileList = minecraftJar.pipe(
    distinctUntilChanged(),
    map(jar => Object.keys(jar.jar.entries))
);

// File list that only contains outer class files
export const classesList = fileList.pipe(
    map(files => files.filter(file => file.endsWith('.class') && !file.includes('$')))
);

const debouncedSearchQuery: Observable<string> = searchQuery.pipe(
    debounceTime(200),
    distinctUntilChanged()
);

export const searchResults: Observable<string[]> = combineLatest([classesList, debouncedSearchQuery]).pipe(
    switchMap(([classes, query]) => {
        return [performSearch(query, classes)];
    })
);

export const isSearching = searchQuery.pipe(
    map((query) => query.length > 0)
);
