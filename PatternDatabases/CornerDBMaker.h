//
// Created by shoaib-samim on 6/27/25.
//

#ifndef CORNERDBMAKER_H
#define CORNERDBMAKER_H

#include "CornerPatternDatabase.h"

class CornerDBMaker {
private:
    std::string fileName;
    CornerPatternDatabase cornerDB;

public:
    CornerDBMaker(std::string _fileName);
    CornerDBMaker(std::string _fileName, uint8_t init_val);

    bool bfsAndStore();
};

#endif //CORNERDBMAKER_H
